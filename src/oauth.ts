// Minimal OAuth 2.1 authorization server for the MCP endpoint, so claude.ai's
// custom connector can sign in. The "login" is a single password: MCP_AUTH_TOKEN.
// Supports dynamic client registration, authorization code + PKCE (S256), and
// refresh tokens. Tokens are stored hashed in SQLite.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./db";

const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 24 * 3_600_000;
const REFRESH_TTL_MS = 90 * 86_400_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256(a));
  const bb = Buffer.from(sha256(b));
  return timingSafeEqual(ab, bb);
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class OAuth {
  constructor(
    private readonly store: Store,
    private readonly baseUrl: string,
    private readonly password: string,
  ) {}

  get resourceMetadataUrl() {
    return `${this.baseUrl}/.well-known/oauth-protected-resource`;
  }

  /** Accept either the static MCP_AUTH_TOKEN or an OAuth access token. */
  isAuthorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const presented = match[1]!.trim();
    if (safeEqual(presented, this.password)) return true;
    const row = this.store.db
      .query("SELECT expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
      .get(sha256(presented)) as { expires_at: number } | null;
    return row !== null && row.expires_at > Date.now();
  }

  unauthorized(): Response {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${this.resourceMetadataUrl}"`,
      },
    });
  }

  /** Returns a Response if the path is an OAuth route, else null. */
  async route(req: Request, path: string): Promise<Response | null> {
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: `${this.baseUrl}/mcp`,
        authorization_servers: [this.baseUrl],
        bearer_methods_supported: ["header"],
      });
    }
    if (path.startsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/oauth/authorize`,
        token_endpoint: `${this.baseUrl}/oauth/token`,
        registration_endpoint: `${this.baseUrl}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (path === "/oauth/register" && req.method === "POST") return this.register(req);
    if (path === "/oauth/authorize" && req.method === "GET") return this.authorizePage(req);
    if (path === "/oauth/authorize" && req.method === "POST") return this.authorizeSubmit(req);
    if (path === "/oauth/token" && req.method === "POST") return this.token(req);
    return null;
  }

  private async register(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
    if (uris.length === 0 || !uris.every(isAllowedRedirect)) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be https (or http://localhost) URLs");
    }
    const clientId = token();
    const name = typeof body?.client_name === "string" ? body.client_name.slice(0, 200) : null;
    this.store.db
      .query("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
      .run(clientId, name, JSON.stringify(uris), Date.now());
    return json(
      {
        client_id: clientId,
        client_name: name ?? undefined,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  }

  private client(clientId: string): { client_name: string | null; redirect_uris: string[] } | null {
    const row = this.store.db
      .query("SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as { client_name: string | null; redirect_uris: string } | null;
    return row ? { client_name: row.client_name, redirect_uris: JSON.parse(row.redirect_uris) } : null;
  }

  /** Validate authorize params; returns an error Response or the parsed params. */
  private checkAuthorizeParams(p: URLSearchParams) {
    const clientId = p.get("client_id") ?? "";
    const redirectUri = p.get("redirect_uri") ?? "";
    const client = this.client(clientId);
    if (!client) return { error: new Response("Unknown client_id", { status: 400 }) };
    if (!client.redirect_uris.includes(redirectUri)) {
      return { error: new Response("redirect_uri is not registered for this client", { status: 400 }) };
    }
    if (p.get("response_type") !== "code") return { error: redirectError(redirectUri, p, "unsupported_response_type") };
    if (!p.get("code_challenge") || p.get("code_challenge_method") !== "S256") {
      return { error: redirectError(redirectUri, p, "invalid_request", "PKCE S256 is required") };
    }
    return { client, clientId, redirectUri };
  }

  private authorizePage(req: Request, message = ""): Response {
    const params = new URL(req.url).searchParams;
    const checked = this.checkAuthorizeParams(params);
    if (checked.error) return checked.error;
    const hidden = [...params]
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Instagram DM bot</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 20px;color:#222}
input[type=password]{width:100%;padding:10px;font-size:16px;box-sizing:border-box;margin:8px 0 14px}
button{padding:10px 18px;font-size:16px;cursor:pointer}.err{color:#b00020}</style></head><body>
<h2>Connect Instagram DM bot</h2>
<p><b>${escapeHtml(checked.client.client_name ?? "An app")}</b> wants to read and edit the bot's knowledge base and settings.</p>
${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
<form method="post" action="/oauth/authorize">${hidden}
<label>Access password (MCP_AUTH_TOKEN)<input type="password" name="password" autofocus required></label>
<button type="submit">Allow access</button></form></body></html>`;
    return new Response(html, {
      status: message ? 401 : 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" },
    });
  }

  private async authorizeSubmit(req: Request): Promise<Response> {
    const form = await req.formData();
    const params = new URLSearchParams();
    for (const [k, v] of form) if (k !== "password" && typeof v === "string") params.set(k, v);
    const checked = this.checkAuthorizeParams(params);
    if (checked.error) return checked.error;

    if (!safeEqual(String(form.get("password") ?? ""), this.password)) {
      await Bun.sleep(1000); // slow down guessing
      const url = new URL(req.url);
      url.search = params.toString();
      return this.authorizePage(new Request(url.toString()), "Wrong password.");
    }

    const code = token();
    this.store.db
      .query(
        "INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sha256(code), checked.clientId, checked.redirectUri, params.get("code_challenge")!, Date.now() + CODE_TTL_MS);
    const target = new URL(checked.redirectUri);
    target.searchParams.set("code", code);
    if (params.get("state")) target.searchParams.set("state", params.get("state")!);
    return Response.redirect(target.toString(), 302);
  }

  private async token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const grant = form.get("grant_type");
    const clientId = form.get("client_id") ?? "";

    if (grant === "authorization_code") {
      const codeHash = sha256(form.get("code") ?? "");
      const row = this.store.db.query("SELECT * FROM oauth_codes WHERE code = ?").get(codeHash) as {
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        expires_at: number;
      } | null;
      this.store.db.query("DELETE FROM oauth_codes WHERE code = ? OR expires_at < ?").run(codeHash, Date.now());
      if (!row || row.expires_at < Date.now()) return oauthError("invalid_grant", "Code is invalid or expired");
      if (row.client_id !== clientId || row.redirect_uri !== form.get("redirect_uri")) {
        return oauthError("invalid_grant", "client_id or redirect_uri mismatch");
      }
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== row.code_challenge) return oauthError("invalid_grant", "PKCE verification failed");
      return this.issueTokens(clientId);
    }

    if (grant === "refresh_token") {
      const hash = sha256(form.get("refresh_token") ?? "");
      const row = this.store.db
        .query("SELECT client_id, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
        .get(hash) as { client_id: string; expires_at: number } | null;
      if (!row || row.expires_at < Date.now() || row.client_id !== clientId) {
        return oauthError("invalid_grant", "Refresh token is invalid or expired");
      }
      this.store.db.query("DELETE FROM oauth_tokens WHERE token_hash = ?").run(hash); // rotate
      return this.issueTokens(clientId);
    }

    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  private issueTokens(clientId: string): Response {
    const now = Date.now();
    const access = token();
    const refresh = token();
    const insert = this.store.db.query(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, expires_at) VALUES (?, ?, ?, ?)",
    );
    insert.run(sha256(access), "access", clientId, now + ACCESS_TTL_MS);
    insert.run(sha256(refresh), "refresh", clientId, now + REFRESH_TTL_MS);
    this.store.db.query("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now);
    return json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
    });
  }
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch {
    return false;
  }
}

function redirectError(redirectUri: string, p: URLSearchParams, error: string, description?: string): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (description) target.searchParams.set("error_description", description);
  if (p.get("state")) target.searchParams.set("state", p.get("state")!);
  return Response.redirect(target.toString(), 302);
}
