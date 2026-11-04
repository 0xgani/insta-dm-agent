// Central env parsing. Bun loads .env automatically.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export type InstagramAuthMode = "facebook" | "instagram";

export function loadConfig() {
  const authMode = optional("INSTAGRAM_AUTH_MODE", "facebook") as InstagramAuthMode;
  if (authMode !== "facebook" && authMode !== "instagram") {
    throw new Error(`INSTAGRAM_AUTH_MODE must be "facebook" or "instagram", got "${authMode}"`);
  }
  const publicBaseUrl = optional("PUBLIC_BASE_URL", "").replace(/\/+$/, "");

  return {
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    // Only needed for keys not scoped to a workspace (sk-ant-usr-...).
    anthropicWorkspaceId: optional("ANTHROPIC_WORKSPACE_ID", ""),
    claudeModel: optional("CLAUDE_MODEL", "claude-haiku-5-5"),

    instagram: {
      authMode,
      accessToken: required("INSTAGRAM_ACCESS_TOKEN"),
      // Facebook-login mode sends via INSTAGRAM_ACCOUNT_ID (system-user token) or
      // FACEBOOK_PAGE_ID (Page token); one of them is required.
      pageId: optional("FACEBOOK_PAGE_ID", ""),
      accountId:
        authMode === "facebook" && !process.env.FACEBOOK_PAGE_ID
          ? required("INSTAGRAM_ACCOUNT_ID")
          : optional("INSTAGRAM_ACCOUNT_ID", ""),
      appSecret: required("META_APP_SECRET"),
      verifyToken: required("WEBHOOK_VERIFY_TOKEN"),
      graphVersion: optional("META_GRAPH_VERSION", "v26.0"),
    },

    telegram: {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      chatId: required("TELEGRAM_CHAT_ID"),
    },

    mcpAuthToken: required("MCP_AUTH_TOKEN"),
    publicBaseUrl,
    port: Number(optional("PORT", "3000")),
    dbPath: optional("DB_PATH", "./data/bot.db"),
    memoryPath: optional("MEMORY_PATH", "./MEMORY.md"),
    defaultCooldownHours: Number(optional("COOLDOWN_HOURS", "6")),
    debounceMs: Number(optional("DEBOUNCE_MS", "4000")),
  };
}

export type Config = ReturnType<typeof loadConfig>;
