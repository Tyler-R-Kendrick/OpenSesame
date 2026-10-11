/**
 * Every live key, and what each may still spend (ADR 0189 §6).
 *
 * The ledger is memory, by design: a key does not outlive the vault session
 * that issued it, so locking, reloading or closing the tab revokes every key
 * (ADR 0150 §1 says the same of a surrogate). Rows are found by the digest of
 * the key, never by the key; the key itself is shown once and not kept.
 *
 * Authority is *conserved* down the chain. A child's budget is carved out of
 * its parent's remaining budget when it is issued, so two children of a
 * parent holding 100 cannot each hold 100, and what a child leaves unspent
 * goes back to the parent when it ends. Without that, splitting a key would
 * be a way to spend its budget twice.
 */
import { refuse } from "./errors.js";
import type { Allocation, KeyRecord, KeyView } from "./types.js";
import { CONSUMABLES, LIMITS } from "./vocabulary.js";

export class KeyLedger {
  private readonly byId = new Map<string, KeyRecord>();
  private readonly byDigest = new Map<string, string>();
  /** The latest time ever seen: the clock never runs backwards inside the ledger. */
  private highWater = 0;

  /** `now`, held to the latest time seen so a rolled-back clock cannot revive an expired key. */
  clock(now: number): number {
    this.highWater = Math.max(this.highWater, now);
    return this.highWater;
  }

  get size(): number {
    return this.byId.size;
  }

  find(id: string): KeyRecord | null {
    return this.byId.get(id) ?? null;
  }

  findByDigest(digest: string): KeyRecord | null {
    const id = this.byDigest.get(digest);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  records(): readonly KeyRecord[] {
    return [...this.byId.values()];
  }

  children(id: string): KeyRecord[] {
    return this.records().filter((row) => row.grant.parentGrantId === id);
  }

  /** The children of `id` that are neither revoked nor expired at `now`. */
  liveChildren(id: string, now: number): KeyRecord[] {
    return this.children(id).filter((row) => this.isActiveSelf(row, now));
  }

  /** Is this row, and every row above it, live at `now`? */
  isActive(record: KeyRecord, now: number): boolean {
    let current: KeyRecord | null = record;
    while (current) {
      const { notBefore, expiresAt } = current.grant.constraints;
      if (
        current.revokedAt !== null ||
        now >= expiresAt.getTime() ||
        (notBefore !== null && now < notBefore.getTime())
      )
        return false;
      const parent: string | null = current.grant.parentGrantId;
      current = parent === null ? null : this.find(parent);
      // A parent that is gone ends the chain: its children cannot outlive it.
      if (parent !== null && current === null) return false;
    }
    return true;
  }

  add(record: KeyRecord): void {
    if (this.byId.size >= LIMITS.maxKeys)
      refuse("temporarily_unavailable", "ledger.full");
    this.byId.set(record.id, record);
    this.byDigest.set(record.digest, record.id);
  }

  /** Revoke a key and everything issued from it; returns every id revoked. */
  revoke(id: string, now: number): string[] {
    const root = this.find(id);
    if (!root) return [];
    const ended: KeyRecord[] = [];
    const walk = (record: KeyRecord) => {
      for (const child of this.children(record.id)) walk(child);
      if (record.revokedAt !== null) return;
      record.revokedAt = now;
      ended.push(record);
    };
    walk(root);
    this.reclaim(now);
    return ended.map((record) => record.id);
  }

  /**
   * Give each ended key's unspent budget back to its parent, deepest first,
   * so a grandchild's remainder reaches the root through its parent.
   */
  reclaim(now: number): void {
    const ended = this.records()
      .filter((row) => !row.returned && !this.isActiveSelf(row, now))
      .sort((a, b) => b.grant.delegationDepth - a.grant.delegationDepth);
    for (const record of ended) {
      const parent = record.grant.parentGrantId
        ? this.find(record.grant.parentGrantId)
        : null;
      if (parent && !parent.returned) {
        for (const key of CONSUMABLES)
          parent.remaining[key] += record.remaining[key];
      }
      for (const key of CONSUMABLES) record.remaining[key] = 0;
      record.returned = true;
    }
  }

  /** Forget rows that ended and gave everything back. */
  purge(): void {
    for (const record of this.records()) {
      if (
        record.returned &&
        record.inflight === 0 &&
        this.children(record.id).every((c) => c.returned)
      ) {
        this.byId.delete(record.id);
        this.byDigest.delete(record.digest);
      }
    }
  }

  clear(): void {
    this.byId.clear();
    this.byDigest.clear();
  }

  private isActiveSelf(record: KeyRecord, now: number): boolean {
    return (
      record.revokedAt === null &&
      now < record.grant.constraints.expiresAt.getTime()
    );
  }

  view(record: KeyRecord, now: number): KeyView {
    const { grant } = record;
    const ended = record.revokedAt !== null;
    return {
      id: record.id,
      parentId: grant.parentGrantId,
      clientId: grant.clientId ?? "",
      providerId: record.provider.providerId,
      connectionId: grant.connectionId ?? "",
      actions: grant.actions,
      models: grant.resources,
      remaining: { ...record.remaining } satisfies Allocation,
      maxOutputTokens: grant.constraints.budgets.max_output_tokens ?? 0,
      depth: grant.delegationDepth,
      bound: grant.proofKeyThumbprint !== null,
      expiresAt: grant.constraints.expiresAt.getTime(),
      status: ended
        ? "revoked"
        : this.isActive(record, now)
          ? "active"
          : "expired",
    };
  }
}
