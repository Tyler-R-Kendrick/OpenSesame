import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CheckpointJournal } from "./types.js";

const envelopeSchema = z
  .object({
    version: z.literal(1),
    previous: z.string().regex(/^[a-f0-9]{64}$/),
    iv: z.string().min(1),
    tag: z.string().min(1),
    data: z.string().min(1),
  })
  .strict();
const EMPTY_DIGEST = "0".repeat(64);

export class FileCheckpointJournal implements CheckpointJournal {
  private operation: Promise<void> = Promise.resolve();
  private readonly expected = new Map<string, string>();

  private constructor(
    private readonly directory: string,
    private readonly key: Uint8Array,
  ) {}

  static async open(
    directory: string,
    key?: Uint8Array,
  ): Promise<FileCheckpointJournal> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolvedKey =
      key ?? (await journalKey(join(directory, "journal.key")));
    if (resolvedKey.byteLength !== 32)
      throw new Error("A journal key must contain 32 bytes");
    return new FileCheckpointJournal(directory, Uint8Array.from(resolvedKey));
  }

  async load(runId: string): Promise<readonly unknown[]> {
    await this.operation;
    return (await this.read(runId)).events;
  }

  append(runId: string, event: unknown): Promise<void> {
    const result = this.operation.then(() => this.appendLocked(runId, event));
    this.operation = result.catch(() => {});
    return result;
  }

  private async appendLocked(runId: string, event: unknown): Promise<void> {
    await this.acquire(runId);
    try {
      const current = await this.read(runId);
      const expected = this.expected.get(runId);
      if (expected !== undefined && expected !== current.digest)
        throw new Error("A stale journal writer was fenced");
      const serialized = JSON.stringify(event);
      if (serialized === undefined || serialized.length > 1_000_000)
        throw new Error("Journal event exceeds its bound");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(Buffer.from(`${runId}:${current.digest}`));
      const data = Buffer.concat([
        cipher.update(serialized, "utf8"),
        cipher.final(),
      ]);
      const line = `${JSON.stringify({
        version: 1,
        previous: current.digest,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        data: data.toString("base64url"),
      })}\n`;
      const file = await open(this.filename(runId), "a", 0o600);
      try {
        await file.writeFile(line, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      this.expected.set(runId, digest(line));
    } finally {
      await unlink(this.lockname(runId)).catch(() => {});
    }
  }

  private async read(
    runId: string,
  ): Promise<{ events: unknown[]; digest: string }> {
    let text: string;
    try {
      text = await readFile(this.filename(runId), "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return { events: [], digest: EMPTY_DIGEST };
      throw error;
    }
    if (text.length > 32_000_000) throw new Error("Journal exceeds its bound");
    const events: unknown[] = [];
    let previous = EMPTY_DIGEST;
    for (const line of text.split("\n").filter((part) => part !== "")) {
      const envelope = envelopeSchema.parse(JSON.parse(line));
      if (envelope.previous !== previous)
        throw new Error("Journal chain is invalid");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(`${runId}:${previous}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      events.push(JSON.parse(plaintext));
      previous = digest(`${line}\n`);
    }
    return { events, digest: previous };
  }

  private async acquire(runId: string): Promise<void> {
    const create = () =>
      writeFile(this.lockname(runId), String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
    try {
      return await create();
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const owner = Number(await readFile(this.lockname(runId), "utf8"));
      if (!Number.isInteger(owner) || owner < 1)
        throw new Error("Journal writer lease is invalid");
      try {
        process.kill(owner, 0);
      } catch {
        await unlink(this.lockname(runId));
        return create();
      }
      throw new Error("Another journal writer holds the run lease");
    }
  }

  private filename(runId: string): string {
    return join(
      this.directory,
      `${createHash("sha256").update(runId).digest("hex")}.journal`,
    );
  }

  private lockname(runId: string): string {
    return `${this.filename(runId)}.lock`;
  }
}

async function journalKey(filename: string): Promise<Uint8Array> {
  try {
    return await readFile(filename);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
    const key = randomBytes(32);
    try {
      const file = await open(filename, "wx", 0o600);
      try {
        await file.writeFile(key);
        await file.sync();
      } finally {
        await file.close();
      }
      return key;
    } catch (writeError) {
      if (isCode(writeError, "EEXIST")) return readFile(filename);
      throw writeError;
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
