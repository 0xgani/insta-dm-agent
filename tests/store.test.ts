import { describe, expect, test } from "bun:test";
import { HISTORY_LIMIT, Store } from "../src/db";

const HOUR = 3_600_000;

function makeStore(start = 1_000_000) {
  let now = start;
  const store = new Store(":memory:", { defaultCooldownHours: 6, now: () => now });
  return { store, advance: (ms: number) => (now += ms), now: () => now };
}

describe("history pruning", () => {
  test(`keeps only the last ${HISTORY_LIMIT} messages per user`, () => {
    const { store } = makeStore();
    for (let i = 1; i <= 30; i++) store.addMessage("u1", i % 2 ? "user" : "assistant", `m${i}`);
    store.addMessage("u2", "user", "other user");

    const history = store.getHistory("u1");
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]!.text).toBe("m11");
    expect(history.at(-1)!.text).toBe("m30");
    expect(store.getHistory("u2")).toHaveLength(1);
  });

  test("a reply inserted after an earlier message stays in conversation order", () => {
    const { store } = makeStore();
    store.addMessage("u1", "user", "first");
    const answered = store.getHistory("u1").at(-1)!.pos;
    store.addMessage("u1", "user", "second (sent while bot was thinking)");
    store.addMessage("u1", "assistant", "reply to first", answered);
    expect(store.getHistory("u1").map((m) => m.text)).toEqual([
      "first",
      "reply to first",
      "second (sent while bot was thinking)",
    ]);
  });
});

describe("pause logic", () => {
  test("pause lasts the cooldown, then the bot is active again", () => {
    const { store, advance } = makeStore();
    expect(store.isPaused("u1")).toBe(false);
    store.pauseUser("u1");
    expect(store.isPaused("u1")).toBe(true);
    advance(6 * HOUR - 1);
    expect(store.isPaused("u1")).toBe(true);
    advance(2);
    expect(store.isPaused("u1")).toBe(false);
  });

  test("each new owner message resets the timer", () => {
    const { store, advance } = makeStore();
    store.pauseUser("u1");
    advance(5 * HOUR);
    store.pauseUser("u1"); // owner replied again
    advance(5 * HOUR);
    expect(store.isPaused("u1")).toBe(true);
    advance(1 * HOUR + 1);
    expect(store.isPaused("u1")).toBe(false);
  });

  test("pauses are per user", () => {
    const { store } = makeStore();
    store.pauseUser("u1");
    expect(store.isPaused("u2")).toBe(false);
  });
});

describe("cooldown setting", () => {
  test("set_cooldown changes the length of the next pause, not running ones", () => {
    const { store, now } = makeStore();
    store.pauseUser("running");
    expect(store.getPausedUntil("running")).toBe(now() + 6 * HOUR);

    store.setCooldownHours(2);
    expect(store.getCooldownHours()).toBe(2);
    store.pauseUser("next");
    expect(store.getPausedUntil("next")).toBe(now() + 2 * HOUR);
    expect(store.getPausedUntil("running")).toBe(now() + 6 * HOUR);
  });

  test("rejects out-of-range values", () => {
    const { store } = makeStore();
    expect(() => store.setCooldownHours(0.5)).toThrow(RangeError);
    expect(() => store.setCooldownHours(169)).toThrow(RangeError);
    expect(() => store.setCooldownHours(Number.NaN)).toThrow(RangeError);
    expect(store.getCooldownHours()).toBe(6);
  });

  test("env default only seeds the first run; the DB value wins after", () => {
    const path = `/tmp/insta-dm-agent-test-${crypto.randomUUID()}.db`;
    const first = new Store(path, { defaultCooldownHours: 6 });
    first.setCooldownHours(12);
    first.db.close();
    const second = new Store(path, { defaultCooldownHours: 3 });
    expect(second.getCooldownHours()).toBe(12);
    second.db.close();
  });
});

describe("dedupe", () => {
  test("markSeen is true only the first time", () => {
    const { store } = makeStore();
    expect(store.markSeen("mid.1")).toBe(true);
    expect(store.markSeen("mid.1")).toBe(false);
  });
});
