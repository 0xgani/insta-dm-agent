import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config";

// Instagram rejects DM text longer than 1000 characters.
const MAX_MESSAGE_CHARS = 1000;

/** Validate Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// --- webhook payload ------------------------------------------------------

interface RawMessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: { type: string }[];
    reply_to?: { story?: { id: string; url?: string } };
  };
}

export interface WebhookPayload {
  object: string;
  entry?: {
    id: string;
    time: number;
    messaging?: RawMessagingEvent[];
    // Alternate shape (dashboard "Test" button, some Instagram-login setups).
    changes?: { field: string; value: RawMessagingEvent }[];
  }[];
}

export interface IncomingMessage {
  mid: string;
  /** The customer's Instagram-scoped ID (for echoes this is the recipient). */
  userId: string;
  accountId: string;
  isEcho: boolean;
  /** Text to store/answer. Non-text messages get a bracketed description. */
  text: string;
  isTextless: boolean;
}

/** Flatten a webhook payload into the message events we care about. */
export function parseWebhook(payload: WebhookPayload): IncomingMessage[] {
  if (payload.object !== "instagram" && payload.object !== "page") return [];
  const out: IncomingMessage[] = [];
  for (const entry of payload.entry ?? []) {
    const events = [
      ...(entry.messaging ?? []),
      ...(entry.changes ?? []).filter((c) => c.field === "messages").map((c) => c.value),
    ];
    for (const ev of events) {
      const msg = ev.message;
      if (!msg?.mid || msg.is_deleted || !ev.sender || !ev.recipient) continue;
      const isEcho = msg.is_echo === true;
      const userId = isEcho ? ev.recipient.id : ev.sender.id;
      const accountId = isEcho ? ev.sender.id : ev.recipient.id;

      let text = msg.text?.trim() ?? "";
      const kinds = (msg.attachments ?? []).map((a) => a.type);
      if (msg.reply_to?.story && text) text = `(replying to your story) ${text}`;
      const isTextless = text === "";
      if (isTextless) {
        if (msg.reply_to?.story) kinds.push("story reply");
        if (msg.is_unsupported) kinds.push("unsupported message");
        text = `[sent ${kinds.length ? kinds.join(", ") : "a non-text message"} with no text]`;
      }
      out.push({ mid: msg.mid, userId, accountId, isEcho, text, isTextless });
    }
  }
  return out;
}

// --- Graph API --------------------------------------------------------------

export class InstagramClient {
  private readonly base: string;
  private readonly sendPath: string;

  constructor(private readonly cfg: Config["instagram"]) {
    const host = cfg.authMode === "facebook" ? "graph.facebook.com" : "graph.instagram.com";
    this.base = `https://${host}/${cfg.graphVersion}`;
    // Facebook-login tokens send via the IG account (system-user tokens) or the Page (Page tokens).
    this.sendPath =
      cfg.authMode === "facebook" ? `/${cfg.accountId || cfg.pageId}/messages` : "/me/messages";
  }

  /** Send a text DM, split into ≤1000-char parts. Returns the sent message IDs. */
  async sendText(recipientId: string, text: string): Promise<string[]> {
    const mids: string[] = [];
    for (const part of splitMessage(text)) {
      const res = await fetch(`${this.base}${this.sendPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.accessToken}`,
        },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { message_id?: string; error?: { message: string } };
      if (!res.ok || !body.message_id) {
        throw new Error(`Instagram send failed (${res.status}): ${body.error?.message ?? "no message_id"}`);
      }
      mids.push(body.message_id);
    }
    return mids;
  }

  /** Best-effort lookup of a user's @username. */
  async getUsername(userId: string): Promise<string | null> {
    // System-user tokens can't read the user node, but can read conversation participants.
    if (this.cfg.authMode === "facebook" && this.cfg.accountId) {
      const body = await this.get<{ data?: { participants?: { data?: { id: string; username?: string }[] } }[] }>(
        `/${this.cfg.accountId}/conversations?platform=instagram&user_id=${userId}&fields=participants`,
      );
      const name = body?.data?.[0]?.participants?.data?.find((p) => p.id === userId)?.username;
      if (name) return name;
    }
    const body = await this.get<{ username?: string; name?: string }>(`/${userId}?fields=username,name`);
    return body?.username ?? body?.name ?? null;
  }

  private async get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }
}

export function splitMessage(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    // Prefer breaking at a paragraph, then a sentence, then a space.
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". ") + 1, window.lastIndexOf("\n"));
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
