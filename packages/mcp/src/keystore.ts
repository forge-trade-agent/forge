/**
 * Local keystore for the MCP server. Holds the capabilities (manage/quote tokens) and X25519
 * secrets for blocks this agent posted or answered. It lives on the user's machine only, is
 * written atomically with 0600 permissions, and its secrets are never returned to the agent.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const Block = z.object({
  rfqId: z.string(),
  side: z.enum(["buy", "sell"]),
  manageToken: z.string(),
  secretKey: z.string(), // base64
  createdAt: z.string(),
});
const Answer = z.object({
  quoteId: z.string(),
  rfqId: z.string(),
  quoteToken: z.string(),
  createdAt: z.string(),
});
const File = z.object({ v: z.literal(1), blocks: z.array(Block), answers: z.array(Answer) });

export type StoredBlock = z.infer<typeof Block>;
export type StoredAnswer = z.infer<typeof Answer>;

export class Keystore {
  readonly file: string;
  private data: z.infer<typeof File> | null = null;

  constructor(file = path.join(process.env["FORGE_HOME"] ?? path.join(homedir(), ".forge"), "keystore.json")) {
    this.file = file;
  }

  private async load() {
    if (this.data) return this.data;
    try {
      this.data = File.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`keystore unreadable: ${(err as Error).message}`);
      this.data = { v: 1, blocks: [], answers: [] };
    }
    return this.data;
  }

  private async save() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    await chmod(this.file, 0o600).catch(() => undefined); // best effort on Windows
  }

  async addBlock(b: StoredBlock) {
    (await this.load()).blocks.push(b);
    await this.save();
  }
  async addAnswer(a: StoredAnswer) {
    (await this.load()).answers.push(a);
    await this.save();
  }
  async block(rfqId: string): Promise<StoredBlock | undefined> {
    return (await this.load()).blocks.find((b) => b.rfqId === rfqId);
  }
  async answer(quoteId: string): Promise<StoredAnswer | undefined> {
    return (await this.load()).answers.find((a) => a.quoteId === quoteId);
  }
  async list() {
    const d = await this.load();
    return {
      blocks: d.blocks.map((b) => ({ rfqId: b.rfqId, side: b.side, createdAt: b.createdAt })),
      answers: d.answers.map((a) => ({ quoteId: a.quoteId, rfqId: a.rfqId, createdAt: a.createdAt })),
    };
  }
}
