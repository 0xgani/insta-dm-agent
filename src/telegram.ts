import type { Config } from "./config";

export class Telegram {
  constructor(private readonly cfg: Config["telegram"]) {}

  async send(text: string): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.cfg.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[telegram] send failed ${res.status}: ${await res.text()}`);
    } catch (err) {
      console.error("[telegram] send failed:", err);
    }
  }
}
