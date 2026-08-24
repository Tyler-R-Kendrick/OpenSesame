import type { ClaimItem, ClaimSession } from "@opensesame/os-domain";
import { DomainError } from "@opensesame/os-domain";
import type { ClaimCompareAndSwapResult, ClaimStore } from "./store.js";

/** In-memory ClaimStore with mutex-style CAS for concurrent completion tests. */
export class MemoryClaimStore implements ClaimStore {
  private readonly sessions = new Map<string, ClaimSession>();
  private readonly items = new Map<string, ClaimItem[]>();
  private readonly locks = new Map<string, Promise<void>>();

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(
      id,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async get(id: string): Promise<ClaimSession | undefined> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : undefined;
  }

  async getItems(claimId: string): Promise<ClaimItem[]> {
    return structuredClone(this.items.get(claimId) ?? []);
  }

  async putItems(claimId: string, items: ClaimItem[]): Promise<void> {
    this.items.set(claimId, structuredClone(items));
  }

  async create(
    session: ClaimSession,
    items: ClaimItem[],
  ): Promise<ClaimSession> {
    return this.withLock(session.id, async () => {
      if (this.sessions.has(session.id)) {
        throw new DomainError("CONFLICT", "Claim already exists", {
          id: session.id,
        });
      }
      this.sessions.set(session.id, structuredClone(session));
      this.items.set(session.id, structuredClone(items));
      return structuredClone(session);
    });
  }

  async compareAndSwap(
    id: string,
    expectedVersion: number,
    next: ClaimSession,
  ): Promise<ClaimCompareAndSwapResult> {
    return this.withLock(id, async () => {
      const current = this.sessions.get(id);
      if (!current) {
        throw new DomainError("NOT_FOUND", "Claim not found", { id });
      }
      if (current.version !== expectedVersion) {
        return { session: structuredClone(current), won: false };
      }
      if (current.targetManifestDigest !== next.targetManifestDigest) {
        throw new DomainError(
          "IMMUTABLE_FIELD",
          "targetManifestDigest is immutable",
          { id },
        );
      }
      const stored = structuredClone(next);
      this.sessions.set(id, stored);
      return { session: structuredClone(stored), won: true };
    });
  }
}
