import { createHmac } from "node:crypto";
import type { WebStorage } from "@opensesame/app-core/ports.js";
import {
  type CheckpointJournal,
  type JournalEvent,
  journalEventSchema,
} from "@opensesame/cua-password-reset";

/** Web Storage setItem is the host's atomic, sealed whole-value replacement. */
export class SealedCheckpointJournal implements CheckpointJournal {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly storage: WebStorage) {}

  async load(runId: string): Promise<readonly JournalEvent[]> {
    await this.writing;
    const text = this.storage.getItem(this.key(runId));
    if (text === null) return [];
    try {
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value)) throw new Error("not an array");
      return journalEventSchema.array().parse(structuredClone(value));
    } catch {
      throw new Error("Password-reset checkpoint journal is invalid");
    }
  }

  append(runId: string, event: JournalEvent): Promise<void> {
    const append = this.writing.then(() => {
      const current = this.storage.getItem(this.key(runId));
      const events: unknown = current === null ? [] : JSON.parse(current);
      if (!Array.isArray(events)) throw new Error("invalid journal");
      events.push(structuredClone(event));
      this.storage.setItem(this.key(runId), JSON.stringify(events));
    });
    this.writing = append.catch(() => undefined);
    return append;
  }

  private key(runId: string): string {
    const key = `opensesame.password-reset.journal.v1:${runId}`;
    const digest = createHmac("sha256", key)
      .update("checkpoint")
      .digest("base64url");
    return `opensesame.password-reset.${digest}`;
  }
}
