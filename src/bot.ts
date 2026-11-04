import type { Store } from "./db";
import type { IncomingMessage } from "./instagram";
import type { HistoryMessage, ReplyResult } from "./reply-engine";

export interface BotDeps {
  store: Store;
  readMemory: () => Promise<string>;
  engine: {
    reply(
      memory: string,
      history: HistoryMessage[],
      onRequestHuman: (reason: string) => Promise<void>,
    ): Promise<ReplyResult>;
  };
  sender: { sendText(userId: string, text: string): Promise<string[]> };
  lookupUsername: (userId: string) => Promise<string | null>;
  notify: (text: string) => Promise<void>;
  debounceMs: number;
  /** Our own Instagram account ID; learned from webhooks if empty. */
  accountId?: string;
}

/**
 * Orchestrates DM handling: per-user serial queue, debounce, pause/handoff.
 * All work for one user runs in order, so a bot reply's echo is always
 * processed after its message ID has been recorded.
 */
export class Bot {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private accountId: string;

  constructor(private readonly deps: BotDeps) {
    this.accountId = deps.accountId ?? "";
  }

  /** Entry point for each parsed webhook message. Never throws. */
  handle(msg: IncomingMessage) {
    if (!this.accountId) this.accountId = msg.accountId;
    // Ignore events for other accounts, and the account messaging itself.
    if (msg.accountId !== this.accountId || msg.userId === this.accountId) {
      console.warn(`[bot] ignored ${msg.mid}: account ${msg.accountId} is not ours (${this.accountId})`);
      return;
    }
    if (!this.deps.store.markSeen(msg.mid)) return; // duplicate delivery

    if (msg.isEcho) {
      this.enqueue(msg.userId, () => this.handleEcho(msg));
    } else {
      this.deps.store.addMessage(msg.userId, "user", msg.text);
      this.scheduleReply(msg.userId);
    }
  }

  /** Wait for all queued work (used by tests and shutdown). */
  async idle() {
    while (this.timers.size || this.queues.size) {
      await Promise.all([...this.queues.values()]);
      await Bun.sleep(5);
    }
  }

  private handleEcho(msg: IncomingMessage) {
    const { store } = this.deps;
    if (store.isBotSent(msg.mid)) return; // our own reply, already stored
    // A human replied from the Instagram app: record it and (re)start the pause.
    store.addMessage(msg.userId, "owner", msg.text);
    const until = store.pauseUser(msg.userId);
    console.log(`[bot] owner replied to ${msg.userId}; paused until ${new Date(until).toISOString()}`);
  }

  private scheduleReply(userId: string) {
    clearTimeout(this.timers.get(userId));
    this.timers.set(
      userId,
      setTimeout(() => {
        this.timers.delete(userId);
        this.enqueue(userId, () => this.reply(userId));
      }, this.deps.debounceMs),
    );
  }

  private enqueue(userId: string, job: () => unknown) {
    const prev = this.queues.get(userId) ?? Promise.resolve();
    const next = prev
      .then(async () => void (await job()))
      .catch((err) => console.error(`[bot] job for ${userId} failed:`, err))
      .finally(() => {
        if (this.queues.get(userId) === next) this.queues.delete(userId);
      });
    this.queues.set(userId, next);
  }

  private async reply(userId: string) {
    const { store, engine, sender, notify } = this.deps;
    if (store.isPaused(userId)) return;
    const history = store.getHistory(userId);
    const last = history.at(-1);
    if (last?.role !== "user") return; // nothing new to answer

    let result: ReplyResult;
    try {
      result = await engine.reply(await this.deps.readMemory(), history, async (reason) => {
        store.pauseUser(userId);
        const name = await this.username(userId);
        await notify(
          `User @${name} is waiting for a real person reply, check your DMs.` +
            (reason ? `\nTopic: ${reason}` : ""),
        );
      });
    } catch (err) {
      // SDK already retried. Stay silent to the customer, tell the team.
      console.error(`[bot] Claude failed for ${userId}:`, err);
      const name = await this.username(userId);
      await notify(`Bot could not answer @${name} (Claude API error). Please check your DMs.`);
      return;
    }

    if (!result.text) return;
    const mids = await sender.sendText(userId, result.text);
    for (const mid of mids) store.recordBotSent(mid, userId);
    store.addMessage(userId, "assistant", result.text, last.pos);
  }

  private async username(userId: string): Promise<string> {
    const { store, lookupUsername } = this.deps;
    let name = store.getUsername(userId);
    if (!name) {
      name = await lookupUsername(userId);
      if (name) store.setUsername(userId, name);
    }
    return name ?? userId;
  }
}
