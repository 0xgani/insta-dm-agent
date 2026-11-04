import { mkdirSync, readdirSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";

const MAX_BACKUPS = 50;

/** Reads and edits MEMORY.md, keeping a timestamped backup before every write. */
export class MemoryFile {
  readonly backupDir: string;

  constructor(readonly path: string) {
    this.backupDir = join(dirname(path), ".memory-backups");
  }

  async read(): Promise<string> {
    const file = Bun.file(this.path);
    return (await file.exists()) ? await file.text() : "";
  }

  async write(content: string): Promise<string | null> {
    const backup = this.backup();
    await Bun.write(this.path, content);
    return backup;
  }

  /** Replace exactly one occurrence of `oldText`. */
  async replace(oldText: string, newText: string): Promise<string | null> {
    const current = await this.read();
    const count = current.split(oldText).length - 1;
    if (oldText === "" || count === 0) throw new Error("old_text was not found in MEMORY.md");
    if (count > 1) {
      throw new Error(`old_text appears ${count} times; include more surrounding text so it is unique`);
    }
    return this.write(current.replace(oldText, () => newText));
  }

  listBackups(): string[] {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir).filter((f) => f.endsWith(".md")).sort().reverse();
  }

  async restore(backupName: string): Promise<string | null> {
    const name = basename(backupName); // no path traversal
    const src = join(this.backupDir, name);
    if (!existsSync(src)) throw new Error(`No backup named ${name}`);
    return this.write(await Bun.file(src).text());
  }

  private backup(): string | null {
    if (!existsSync(this.path)) return null;
    mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `MEMORY-${stamp}.md`;
    copyFileSync(this.path, join(this.backupDir, name));
    for (const old of this.listBackups().slice(MAX_BACKUPS)) unlinkSync(join(this.backupDir, old));
    return name;
  }
}
