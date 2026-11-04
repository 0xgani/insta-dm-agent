import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { MAX_COOLDOWN_HOURS, MIN_COOLDOWN_HOURS, type Store } from "./db";
import type { MemoryFile } from "./memory";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

function buildServer(store: Store, memory: MemoryFile): McpServer {
  const server = new McpServer({ name: "insta-dm-agent", version: "1.0.0" });

  server.registerTool(
    "read_memory",
    {
      title: "Read knowledge base",
      description:
        "Return the full MEMORY.md knowledge base the Instagram DM bot answers from. Read it before editing.",
      annotations: { readOnlyHint: true },
    },
    async () => text((await memory.read()) || "(MEMORY.md is empty)"),
  );

  server.registerTool(
    "edit_memory",
    {
      title: "Overwrite knowledge base",
      description:
        "Replace the whole MEMORY.md with new content. The bot uses it on the next reply. A backup of the previous version is kept. For small changes prefer replace_in_memory.",
      inputSchema: { content: z.string().describe("The complete new MEMORY.md content (markdown).") },
      annotations: { destructiveHint: true },
    },
    async ({ content }) => {
      const backup = await memory.write(content);
      return text(`MEMORY.md saved (${content.length} chars).${backup ? ` Previous version backed up as ${backup}.` : ""}`);
    },
  );

  server.registerTool(
    "replace_in_memory",
    {
      title: "Edit part of knowledge base",
      description:
        "Replace one exact, unique occurrence of old_text in MEMORY.md with new_text. Fails if old_text is missing or appears more than once. A backup is kept.",
      inputSchema: {
        old_text: z.string().min(1).describe("Exact text currently in MEMORY.md (must be unique)."),
        new_text: z.string().describe("Replacement text. Empty string deletes old_text."),
      },
    },
    async ({ old_text, new_text }) => {
      try {
        const backup = await memory.replace(old_text, new_text);
        return text(`Replaced. Previous version backed up as ${backup}.`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "list_memory_backups",
    {
      title: "List knowledge base backups",
      description: "List saved MEMORY.md backups, newest first (up to 50 are kept).",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const backups = memory.listBackups();
      return text(backups.length ? backups.join("\n") : "No backups yet.");
    },
  );

  server.registerTool(
    "restore_memory_backup",
    {
      title: "Roll back knowledge base",
      description:
        "Restore MEMORY.md from a backup listed by list_memory_backups. The current version is backed up first.",
      inputSchema: { backup: z.string().describe("Backup file name, e.g. MEMORY-2026-11-04T10-00-00-000Z.md") },
      annotations: { destructiveHint: true },
    },
    async ({ backup }) => {
      try {
        const saved = await memory.restore(backup);
        return text(`Restored ${backup}.${saved ? ` The version it replaced is backed up as ${saved}.` : ""}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "get_cooldown",
    {
      title: "Get pause cooldown",
      description:
        "How many hours the bot stays silent for a user after the owner replies manually or the user asks for a human.",
      annotations: { readOnlyHint: true },
    },
    async () => text(`Cooldown is ${store.getCooldownHours()} hours.`),
  );

  server.registerTool(
    "set_cooldown",
    {
      title: "Set pause cooldown",
      description: `Set the pause cooldown in hours (${MIN_COOLDOWN_HOURS}-${MAX_COOLDOWN_HOURS}). Applies to pauses that start after the change; pauses already running keep their end time.`,
      inputSchema: {
        hours: z.number().min(MIN_COOLDOWN_HOURS).max(MAX_COOLDOWN_HOURS).describe("Cooldown in hours."),
      },
    },
    async ({ hours }) => {
      try {
        store.setCooldownHours(hours);
        return text(`Cooldown set to ${hours} hours. New pauses will use it.`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. */
export async function handleMcpRequest(req: Request, store: Store, memory: MemoryFile): Promise<Response> {
  const server = buildServer(store, memory);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  // JSON-mode responses are complete once returned.
  void server.close();
  return res;
}
