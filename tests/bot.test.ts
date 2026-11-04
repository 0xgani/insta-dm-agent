import { describe, expect, test } from "bun:test";
import { Bot } from "../src/bot";
import { Store } from "../src/db";
import { parseWebhook, type IncomingMessage } from "../src/instagram";
import type { HistoryMessage } from "../src/reply-engine";

const ACCOUNT = "acct";

function setup(opts: { requestHuman?: boolean; fail?: boolean } = {}) {
  const store = new Store(":memory:", { defaultCooldownHours: 6 });
  const sent: { to: string; text: string }[] = [];
  const notes: string[] = [];
  const calls: HistoryMessage[][] = [];
  let n = 0;
  const bot = new Bot({
    store,
    readMemory: async () => "We sell tea.",
    engine: {
      async reply(_memory, history, onRequestHuman) {
        calls.push(history);
        if (opts.fail) throw new Error("API down");
        if (opts.requestHuman) await onRequestHuman("wants a refund");
        return { text: `reply #${calls.length}`, requestedHuman: !!opts.requestHuman, usage: { input: 0, output: 0, cacheRead: 0 } };
      },
    },
    sender: {
      async sendText(to, text) {
        sent.push({ to, text });
        return [`bot-mid-${++n}`];
      },
    },
    lookupUsername: async () => "alice",
    notify: async (t) => void notes.push(t),
    debounceMs: 10,
    accountId: ACCOUNT,
  });
  const msg = (mid: string, text: string, isEcho = false): IncomingMessage => ({
    mid, userId: "u1", accountId: ACCOUNT, isEcho, text, isTextless: false,
  });
  return { store, bot, sent, notes, calls, msg };
}

describe("bot", () => {
  test("debounces rapid messages into one reply", async () => {
    const { bot, sent, calls, msg } = setup();
    bot.handle(msg("m1", "hi"));
    bot.handle(msg("m2", "do you sell tea?"));
    await bot.idle();
    expect(sent).toHaveLength(1);
    expect(calls[0]!.map((m) => m.text)).toEqual(["hi", "do you sell tea?"]);
  });

  test("ignores duplicate webhook deliveries", async () => {
    const { bot, store, msg } = setup();
    bot.handle(msg("m1", "hi"));
    bot.handle(msg("m1", "hi"));
    await bot.idle();
    expect(store.getHistory("u1").filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("echo of the bot's own message does not pause; owner echo does", async () => {
    const { bot, store, sent, msg } = setup();
    bot.handle(msg("m1", "hi"));
    await bot.idle();
    bot.handle(msg("bot-mid-1", "reply #1", true)); // our own echo
    await bot.idle();
    expect(store.isPaused("u1")).toBe(false);

    bot.handle(msg("owner-1", "Hi, this is Sam from the team", true));
    await bot.idle();
    expect(store.isPaused("u1")).toBe(true);
    expect(store.getHistory("u1").at(-1)!.role).toBe("owner");

    bot.handle(msg("m2", "thanks Sam"));
    await bot.idle();
    expect(sent).toHaveLength(1); // still paused, no new bot reply
  });

  test("request_human pauses and notifies Telegram", async () => {
    const { bot, store, notes, msg } = setup({ requestHuman: true });
    bot.handle(msg("m1", "yes please, a person"));
    await bot.idle();
    expect(store.isPaused("u1")).toBe(true);
    expect(notes[0]).toContain("User @alice is waiting for a real person reply, check your DMs.");
  });

  test("Claude failure stays silent to the user and alerts the team", async () => {
    const { bot, sent, notes, msg } = setup({ fail: true });
    bot.handle(msg("m1", "hi"));
    await bot.idle();
    expect(sent).toHaveLength(0);
    expect(notes[0]).toContain("could not answer @alice");
  });
});

describe("parseWebhook", () => {
  test("handles text, echoes, attachments and story replies", () => {
    const parsed = parseWebhook({
      object: "instagram",
      entry: [{
        id: ACCOUNT, time: 0,
        messaging: [
          { sender: { id: "u1" }, recipient: { id: ACCOUNT }, message: { mid: "a", text: "hello" } },
          { sender: { id: ACCOUNT }, recipient: { id: "u1" }, message: { mid: "b", text: "hi!", is_echo: true } },
          { sender: { id: "u1" }, recipient: { id: ACCOUNT }, message: { mid: "c", attachments: [{ type: "audio" }] } },
          { sender: { id: "u1" }, recipient: { id: ACCOUNT }, message: { mid: "d", text: "love it", reply_to: { story: { id: "s" } } } },
          { sender: { id: "u1" }, recipient: { id: ACCOUNT }, message: { mid: "e", is_deleted: true } },
        ],
      }],
    });
    expect(parsed.map((m) => [m.mid, m.userId, m.isEcho, m.text])).toEqual([
      ["a", "u1", false, "hello"],
      ["b", "u1", true, "hi!"],
      ["c", "u1", false, "[sent audio with no text]"],
      ["d", "u1", false, "(replying to your story) love it"],
    ]);
  });
});
