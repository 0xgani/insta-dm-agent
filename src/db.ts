import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const HISTORY_LIMIT = 20;
export const MIN_COOLDOWN_HOURS = 1;
export const MAX_COOLDOWN_HOURS = 168;

export type Role = "user" | "assistant" | "owner";

export interface StoredMessage {
  id: number;
  user_id: string;
  role: Role;
  text: string;
  pos: number;
  created_at: number;
}

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
const MIGRATIONS: string[] = [
  `
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'owner')),
    text       TEXT    NOT NULL,
    pos        REAL    NOT NULL,    -- conversation order (replies slot in after the message they answer)
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_user ON messages (user_id, pos);

  CREATE TABLE users (
    user_id      TEXT PRIMARY KEY,
    username     TEXT,
    paused_until INTEGER            -- NULL or in the past = active
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Webhook dedupe: every message ID we've already handled.
  CREATE TABLE seen_events (
    mid        TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  -- Message IDs the bot itself sent, so echoes can be told apart from owner replies.
  CREATE TABLE bot_sent (
    mid        TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_clients (
    client_id     TEXT PRIMARY KEY,
    client_name   TEXT,
    redirect_uris TEXT NOT NULL,     -- JSON array
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE oauth_codes (
    code           TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at     INTEGER NOT NULL
  );

  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,     -- sha256 of the token
    kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id  TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
];

export class Store {
  readonly db: Database;
  private readonly now: () => number;

  constructor(path: string, opts: { defaultCooldownHours?: number; now?: () => number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.now = opts.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    // Seed only on first run; afterwards the DB value wins over the env var.
    this.db
      .query("INSERT OR IGNORE INTO settings (key, value) VALUES ('cooldown_hours', ?)")
      .run(String(opts.defaultCooldownHours ?? 6));
  }

  private migrate() {
    const { user_version } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  // --- messages ---------------------------------------------------------

  /**
   * Append a message. With `afterPos`, the message is placed right after that
   * position instead (so a reply sits after the message it answered even if
   * the user kept typing while it was generated).
   */
  addMessage(userId: string, role: Role, text: string, afterPos?: number) {
    this.db.transaction(() => {
      const { maxPos } = this.db
        .query("SELECT COALESCE(MAX(pos), 0) AS maxPos FROM messages WHERE user_id = ?")
        .get(userId) as { maxPos: number };
      let pos = maxPos + 1;
      if (afterPos !== undefined) {
        const next = this.db
          .query("SELECT MIN(pos) AS p FROM messages WHERE user_id = ? AND pos > ?")
          .get(userId, afterPos) as { p: number | null };
        if (next.p !== null) pos = (afterPos + next.p) / 2;
      }
      this.db
        .query("INSERT INTO messages (user_id, role, text, pos, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(userId, role, text, pos, this.now());
      this.db
        .query(
          `DELETE FROM messages WHERE user_id = ?1 AND id NOT IN (
             SELECT id FROM messages WHERE user_id = ?1 ORDER BY pos DESC LIMIT ?2)`,
        )
        .run(userId, HISTORY_LIMIT);
    })();
  }

  /** Last HISTORY_LIMIT messages, oldest first. */
  getHistory(userId: string): StoredMessage[] {
    return this.db
      .query(
        `SELECT * FROM (SELECT * FROM messages WHERE user_id = ? ORDER BY pos DESC LIMIT ?)
         ORDER BY pos ASC`,
      )
      .all(userId, HISTORY_LIMIT) as StoredMessage[];
  }

  // --- dedupe / echo tracking ------------------------------------------

  /** Returns true the first time a message ID is seen. */
  markSeen(mid: string): boolean {
    const res = this.db
      .query("INSERT OR IGNORE INTO seen_events (mid, created_at) VALUES (?, ?)")
      .run(mid, this.now());
    return res.changes > 0;
  }

  recordBotSent(mid: string, userId: string) {
    this.db
      .query("INSERT OR IGNORE INTO bot_sent (mid, user_id, created_at) VALUES (?, ?, ?)")
      .run(mid, userId, this.now());
  }

  isBotSent(mid: string): boolean {
    return this.db.query("SELECT 1 FROM bot_sent WHERE mid = ?").get(mid) !== null;
  }

  /** Drop dedupe/echo rows older than `days`. */
  pruneEventLogs(days = 14) {
    const cutoff = this.now() - days * 86_400_000;
    this.db.query("DELETE FROM seen_events WHERE created_at < ?").run(cutoff);
    this.db.query("DELETE FROM bot_sent WHERE created_at < ?").run(cutoff);
  }

  // --- users / pause ---------------------------------------------------

  getUsername(userId: string): string | null {
    const row = this.db.query("SELECT username FROM users WHERE user_id = ?").get(userId) as
      | { username: string | null }
      | null;
    return row?.username ?? null;
  }

  setUsername(userId: string, username: string) {
    this.db
      .query(
        `INSERT INTO users (user_id, username) VALUES (?1, ?2)
         ON CONFLICT (user_id) DO UPDATE SET username = ?2`,
      )
      .run(userId, username);
  }

  /** Pause the bot for this user for the current cooldown, read at this moment. */
  pauseUser(userId: string): number {
    const until = this.now() + this.getCooldownHours() * 3_600_000;
    this.db
      .query(
        `INSERT INTO users (user_id, paused_until) VALUES (?1, ?2)
         ON CONFLICT (user_id) DO UPDATE SET paused_until = ?2`,
      )
      .run(userId, until);
    return until;
  }

  getPausedUntil(userId: string): number | null {
    const row = this.db.query("SELECT paused_until FROM users WHERE user_id = ?").get(userId) as
      | { paused_until: number | null }
      | null;
    return row?.paused_until ?? null;
  }

  isPaused(userId: string): boolean {
    const until = this.getPausedUntil(userId);
    return until !== null && until > this.now();
  }

  // --- settings --------------------------------------------------------

  getCooldownHours(): number {
    const row = this.db.query("SELECT value FROM settings WHERE key = 'cooldown_hours'").get() as
      | { value: string }
      | null;
    return row ? Number(row.value) : 6;
  }

  setCooldownHours(hours: number) {
    if (!Number.isFinite(hours) || hours < MIN_COOLDOWN_HOURS || hours > MAX_COOLDOWN_HOURS) {
      throw new RangeError(
        `cooldown_hours must be a number between ${MIN_COOLDOWN_HOURS} and ${MAX_COOLDOWN_HOURS}`,
      );
    }
    this.db
      .query(
        `INSERT INTO settings (key, value) VALUES ('cooldown_hours', ?1)
         ON CONFLICT (key) DO UPDATE SET value = ?1`,
      )
      .run(String(hours));
  }
}
