import { Bot } from "./bot";
import { loadConfig } from "./config";
import { Store } from "./db";
import { InstagramClient, parseWebhook, verifySignature, type WebhookPayload } from "./instagram";
import { handleMcpRequest } from "./mcp";
import { MemoryFile } from "./memory";
import { OAuth } from "./oauth";
import { ReplyEngine } from "./reply-engine";
import { Telegram } from "./telegram";

const config = loadConfig();
if (!config.publicBaseUrl) console.warn("[server] PUBLIC_BASE_URL is not set; OAuth for claude.ai will not work.");

const store = new Store(config.dbPath, { defaultCooldownHours: config.defaultCooldownHours });
const memory = new MemoryFile(config.memoryPath);
const instagram = new InstagramClient(config.instagram);
const telegram = new Telegram(config.telegram);
const oauth = new OAuth(store, config.publicBaseUrl || `http://localhost:${config.port}`, config.mcpAuthToken);

const bot = new Bot({
  store,
  readMemory: () => memory.read(), // re-read every reply so MCP edits apply immediately
  engine: new ReplyEngine(config.anthropicApiKey, config.claudeModel, config.anthropicWorkspaceId),
  sender: instagram,
  lookupUsername: (id) => instagram.getUsername(id),
  notify: (text) => telegram.send(text),
  debounceMs: config.debounceMs,
  accountId: config.instagram.accountId,
});

setInterval(() => store.pruneEventLogs(), 6 * 3_600_000);

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return Response.json({ ok: true, model: config.claudeModel });

    // Public privacy policy (required by Meta to publish the app).
    if (path === "/privacy") return new Response(Bun.file("public/privacy.html"));

    // Meta webhook verification handshake.
    if (path === "/webhook" && req.method === "GET") {
      const p = url.searchParams;
      if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === config.instagram.verifyToken) {
        return new Response(p.get("hub.challenge") ?? "", { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (path === "/webhook" && req.method === "POST") {
      const raw = await req.text();
      console.log(`[webhook] POST ${raw.length} bytes: ${raw.slice(0, 500)}`);
      if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), config.instagram.appSecret)) {
        console.warn("[webhook] bad signature, ignored");
        return new Response("Invalid signature", { status: 401 });
      }
      // Ack immediately; handle asynchronously.
      queueMicrotask(() => {
        try {
          for (const msg of parseWebhook(JSON.parse(raw) as WebhookPayload)) bot.handle(msg);
        } catch (err) {
          console.error("[webhook] failed to process payload:", err);
        }
      });
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    if (path === "/mcp") {
      if (!oauth.isAuthorized(req)) return oauth.unauthorized();
      return handleMcpRequest(req, store, memory);
    }

    const oauthResponse = await oauth.route(req, path);
    if (oauthResponse) return oauthResponse;

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[server] listening on :${server.port} (model ${config.claudeModel})`);
if (config.publicBaseUrl) {
  console.log(`[server] webhook:  ${config.publicBaseUrl}/webhook`);
  console.log(`[server] MCP:      ${config.publicBaseUrl}/mcp`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`[server] ${sig}, finishing queued work...`);
    server.stop();
    await Promise.race([bot.idle(), Bun.sleep(20_000)]);
    store.db.close();
    process.exit(0);
  });
}
