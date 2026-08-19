import type { ClaimItem, ClaimSession, Clock } from "@opensesame/os-domain";
import { DomainError } from "@opensesame/os-domain";
import type { ClaimStore } from "@opensesame/claims";

/**
 * In-memory ClaimStore with CAS + list support for worker cleanup.
 */
export class IndexedClaimStore implements ClaimStore {
  constructor(private readonly clock: Clock = () => new Date()) {}
  private readonly sessions = new Map<string, ClaimSession>();
  private readonly items = new Map<string, ClaimItem[]>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly maxSessions = 10_000;

  private prune(): void {
    const now = this.clock().getTime();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt.getTime() <= now) {
        this.sessions.delete(id);
        this.items.delete(id);
        this.locks.delete(id);
      }
    }
    if (this.sessions.size <= this.maxSessions) return;
    const overflow = this.sessions.size - this.maxSessions;
    const ids = [...this.sessions.keys()].slice(0, overflow);
    for (const id of ids) {
      this.sessions.delete(id);
      this.items.delete(id);
      this.locks.delete(id);
    }
  }

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

  listIds(): string[] {
    return [...this.sessions.keys()];
  }

  listSessions(): ClaimSession[] {
    return [...this.sessions.values()].map((s) => structuredClone(s));
  }

  async get(id: string): Promise<ClaimSession | undefined> {
    this.prune();
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : undefined;
  }

  async getItems(claimId: string): Promise<ClaimItem[]> {
    return structuredClone(this.items.get(claimId) ?? []);
  }

  async putItems(claimId: string, items: ClaimItem[]): Promise<void> {
    this.items.set(claimId, structuredClone(items));
  }

  async create(session: ClaimSession, items: ClaimItem[]): Promise<ClaimSession> {
    return this.withLock(session.id, async () => {
      this.prune();
      if (this.sessions.size >= this.maxSessions) {
        throw new DomainError("CONFLICT", "Claim store at capacity", {
          id: session.id,
        });
      }
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
  ): Promise<{ session: ClaimSession; won: boolean }> {
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

export type { Clock };
