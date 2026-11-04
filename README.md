# Instagram DM auto-reply bot

Answers Instagram DMs with Claude, using only what's in `MEMORY.md`. Hands off to a
human (with a Telegram alert) when it can't help, and goes quiet for a user whenever
you reply to them yourself. An MCP server lets you edit `MEMORY.md` and the cooldown
from claude.ai.

```
Instagram ──webhook──▶ /webhook ──▶ per-user queue + debounce ──▶ Claude (MEMORY.md + last 20 msgs)
                                         │                               │ request_human tool
                                         ▼                               ▼
                                  SQLite (WAL)                     Telegram alert + pause
claude.ai ──OAuth──▶ /mcp ──▶ read/edit MEMORY.md, get/set cooldown
```

## Setup

```bash
bun install
cp .env.example .env      # fill in (see comments in the file)
bun test
bun start                 # http://localhost:3000
bun run tunnel            # in another terminal: public HTTPS URL
```

Put the tunnel URL in `PUBLIC_BASE_URL` and restart the server. It's needed for the OAuth metadata that claude.ai reads.

### Public URL (Cloudflare tunnel)

`bun run tunnel` starts a free **quick tunnel** (`https://<random>.trycloudflare.com`).
It needs no account, but **the URL changes every time cloudflared restarts**, and then you have to
update `PUBLIC_BASE_URL`, the Meta webhook URL, and the claude.ai connector.

For a stable URL, use a named tunnel. It needs a free Cloudflare account and a domain on Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create insta-bot
cloudflared tunnel route dns insta-bot bot.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 insta-bot
```

## Meta app configuration

This uses **Instagram API with Facebook Login** (`INSTAGRAM_AUTH_MODE=facebook`). The
Instagram account must be a professional (Business/Creator) account linked to a Facebook Page.
A **verified Meta Business account** is required before the app can go Live for public use.

1. **developers.facebook.com → your app → Use cases → Instagram API → API setup with Facebook login.**
2. **Token:** in Graph API Explorer, pick the app and generate a *User* token with
   `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`,
   `pages_read_engagement`, `pages_show_list`, `business_management`. Then run:
   ```bash
   bun run scripts/exchange-token.ts <USER_TOKEN>
   ```
   This prints a never-expiring Page token (`INSTAGRAM_ACCESS_TOKEN`), `FACEBOOK_PAGE_ID`
   and `INSTAGRAM_ACCOUNT_ID`.
3. **Webhook:** under *Configure webhooks*, set
   - Callback URL: `https://<PUBLIC_BASE_URL>/webhook`
   - Verify token: the value of `WEBHOOK_VERIFY_TOKEN`
   - Subscribe to the **`messages`** field (this delivers echoes too).
4. **Subscribe the Page to the app** (once):
   ```bash
   curl -X POST "https://graph.facebook.com/v26.0/$FACEBOOK_PAGE_ID/subscribed_apps?subscribed_fields=messages&access_token=$INSTAGRAM_ACCESS_TOKEN"
   ```
5. In the Instagram app: **Settings → Messages and story replies → Message controls →
   Connected tools → Allow access to messages** must be on.
6. While the app is in **Development mode**, only people with a role on the app (admin/developer/tester)
   get replies. For the public, switch the app to Live. That requires App Review for `instagram_manage_messages`
   and Advanced Access.

Webhook payloads are checked against `X-Hub-Signature-256` using `META_APP_SECRET`.

## How it behaves

- **Answers only from `MEMORY.md`**, which is re-read on every reply. When the info isn't there, the bot says so and
  asks if the user wants a real person. If they say yes, Claude calls the `request_human` tool.
- **Handoff:** the user is paused for the cooldown, and Telegram gets
  *"User @X is waiting for a real person reply, check your DMs."*
- **Owner replies:** when you answer from the Instagram app, the echo isn't one of the bot's
  recorded message IDs, so it counts as an owner message. The bot pauses that user for the
  cooldown, and every further owner message restarts the timer. After the cooldown the bot answers again.
- **Cooldown** (default 6 h, range 1–168 h) is stored in SQLite. Changing it affects pauses that
  start afterwards. Pauses that are already running keep their end time.
- **Context:** the last 20 messages per user (user, bot, and your own replies) are stored and survive across days.
- **Concurrency:** WAL mode and a serial queue per user. Messages sent within `DEBOUNCE_MS` (4 s)
  of each other get one combined reply.
- **Dedupe:** each message ID is handled only once, so repeated webhook deliveries are ignored.
- **Non-text** (images, voice, stickers, story replies without text): the bot explains that it only reads text
  and offers a person.
- **Claude errors:** the SDK retries 3 times with a 45 s timeout. If it still fails, the customer gets nothing and
  Telegram gets an alert.
- Replies over 1000 characters are split into several messages, because Instagram limits each message to 1000.

## Connecting the MCP server to claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. URL: `https://<PUBLIC_BASE_URL>/mcp`. Leave the OAuth fields empty; the server supports dynamic registration.
3. Click **Connect**. A login page opens. Enter the `MCP_AUTH_TOKEN` value and click **Allow access**.
4. In a chat, enable the connector and ask things like *"Read the bot's knowledge base and add our new
   opening hours: Mon–Fri 9–18"* or *"Set the bot cooldown to 12 hours."*

Tools: `read_memory`, `edit_memory` (full overwrite), `replace_in_memory` (exact string
replace), `list_memory_backups`, `restore_memory_backup`, `get_cooldown`, `set_cooldown`.
Every edit first saves the previous file in `.memory-backups/` (the last 50 are kept).

Other MCP clients (Claude Code, the MCP Inspector) can skip OAuth and send
`Authorization: Bearer <MCP_AUTH_TOKEN>`:

```bash
claude mcp add --transport http insta-bot https://<PUBLIC_BASE_URL>/mcp --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

## Testing answer quality

```bash
bun run eval                          # model from CLAUDE_MODEL
bun run eval --model claude-sonnet-5-5
bun run eval --compare                # Haiku vs Sonnet side by side, with latency and token totals
bun run eval --file my-questions.txt
```

Edit `scripts/test-questions.txt`. Join messages with ` || ` to test a multi-turn conversation.

## Models

`CLAUDE_MODEL=claude-haiku-5-5` (default) or `claude-sonnet-5-5`. Requests use effort `low`
(this is short-form chat) and cache the system prompt and knowledge base. On Sonnet/Opus,
server-side refusal fallbacks (`fallbacks: "default"`) are enabled. Haiku doesn't support them.

## Deployment

You need one long-running process plus the tunnel. With systemd (user units):

```ini
# ~/.config/systemd/user/insta-bot.service
[Service]
WorkingDirectory=/path/to/insta-dm-agent
ExecStart=/path/to/bun run src/server.ts
Restart=always
[Install]
WantedBy=default.target
```

Add a second unit for `cloudflared tunnel run ...` (named tunnel), then run
`systemctl --user enable --now insta-bot`. Back up `data/bot.db` and `MEMORY.md`.

## Layout

```
src/server.ts        HTTP routes: /webhook, /mcp, OAuth, /health
src/bot.ts           queue, debounce, echo/owner detection, pause, handoff
src/reply-engine.ts  Claude request + request_human tool loop
src/db.ts            SQLite schema/migrations and queries
src/instagram.ts     signature check, webhook parsing, Graph API send
src/mcp.ts           MCP tools
src/oauth.ts         OAuth 2.1 (DCR + PKCE) for claude.ai
src/memory.ts        MEMORY.md read/write/backups
scripts/eval.ts      answer-quality runner
tests/               bun test
```
