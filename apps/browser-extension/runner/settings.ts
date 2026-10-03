/**
 * What a person has told the runner: which Host session to use, which origins
 * it may drive, and which runs it is in the middle of. All of it rests sealed
 * (`store.ts`).
 *
 * Arming an origin is the person's consent for one site, for a bounded time
 * (ADR 0082 §4: "per-ceremony, per-origin and time-boxed, revoked at
 * completion"). The browser's own host permission is the other half — arming
 * without the grant drives nothing, and a grant without arming drives nothing.
 */
import type { RunnerStepOutcome } from "@opensesame/api-client";
import { isJsonObject, isNumber, isString } from "@opensesame/os-domain";
import type { SealedKv } from "./store";
import { decodeOutcome } from "./wire";

/** How long an arm lasts: long enough for a rotation, not for a standing grant. */
export const ARM_TTL_MS = 30 * 60 * 1000;

export interface Armed {
  armedAt: number;
  expiresAt: number;
}

export interface ActiveRun {
  origin: string;
  /** The tab the run is driven in, so a restarted worker finds it again. */
  tabId: number | null;
}

export class RunnerSettings {
  constructor(
    private readonly kv: SealedKv,
    private readonly now: () => number = Date.now,
  ) {}

  // --- the Host session ---------------------------------------------------

  async token(): Promise<string | null> {
    const stored = await this.kv.get("host.token");
    return stored && stored.length > 0 ? stored : null;
  }

  async setToken(token: string): Promise<void> {
    await this.kv.set("host.token", token.trim());
  }

  async clearToken(): Promise<void> {
    await this.kv.remove("host.token");
  }

  // --- armed origins ------------------------------------------------------

  private async readArmed() {
    const stored = await this.kv.getJson("armed");
    const live = new Map<string, Armed>();
    if (!isJsonObject(stored)) return live;
    for (const [origin, row] of Object.entries(stored)) {
      if (!isJsonObject(row)) continue;
      const { armedAt, expiresAt } = row;
      if (isNumber(armedAt) && isNumber(expiresAt)) {
        live.set(origin, { armedAt, expiresAt });
      }
    }
    return live;
  }

  private async writeArmed(rows: Map<string, Armed>): Promise<void> {
    await this.kv.setJson("armed", Object.fromEntries(rows));
  }

  /** The origins still armed. An expired one is not. */
  async armed() {
    const now = this.now();
    const live = new Map<string, Armed>();
    for (const [origin, row] of await this.readArmed()) {
      if (row.expiresAt > now) live.set(origin, row);
    }
    return live;
  }

  async isArmed(origin: string): Promise<boolean> {
    return (await this.armed()).has(origin);
  }

  async arm(origin: string, ttlMs = ARM_TTL_MS): Promise<Armed> {
    const row: Armed = { armedAt: this.now(), expiresAt: this.now() + ttlMs };
    const rows = await this.armed();
    rows.set(origin, row);
    await this.writeArmed(rows);
    return row;
  }

  /** Origins whose arm ran out, so their grants can be given back. */
  async expired(): Promise<string[]> {
    const now = this.now();
    return [...(await this.readArmed())]
      .filter(([, row]) => row.expiresAt <= now)
      .map(([origin]) => origin);
  }

  async disarm(origin: string): Promise<void> {
    const rows = await this.readArmed();
    rows.delete(origin);
    await this.writeArmed(rows);
  }

  // --- runs in flight -----------------------------------------------------

  async active() {
    const stored = await this.kv.getJson("active");
    const rows = new Map<string, ActiveRun>();
    if (!isJsonObject(stored)) return rows;
    for (const [runId, row] of Object.entries(stored)) {
      if (isJsonObject(row) && isString(row.origin)) {
        rows.set(runId, {
          origin: row.origin,
          tabId: isNumber(row.tabId) ? row.tabId : null,
        });
      }
    }
    return rows;
  }

  async markActive(runId: string, run: ActiveRun): Promise<void> {
    const rows = await this.active();
    rows.set(runId, run);
    await this.kv.setJson("active", Object.fromEntries(rows));
  }

  async clearActive(runId: string): Promise<void> {
    const rows = await this.active();
    rows.delete(runId);
    await this.kv.setJson("active", Object.fromEntries(rows));
  }

  // --- the last answer, for a settle that did not arrive ------------------

  /**
   * The outcome of the step this runner last executed for a run, kept until
   * the next one replaces it. A settle that never reached the Host leaves its
   * step to be claimed again once the lease lapses; answering that claim from
   * here, rather than running the step a second time, is what keeps a
   * `submit` from being pressed twice. Outcomes carry no value, so this is
   * safe to hold; reads and frames are not kept, because running them again
   * costs nothing. What is read back is rebuilt through the outcome
   * constructors, so nothing but their own members can be sent.
   */
  async lastOutcome(
    runId: string,
  ): Promise<{ seq: number; outcome: RunnerStepOutcome } | null> {
    const stored = await this.kv.getJson(`last.${runId}`);
    if (!isJsonObject(stored) || !isNumber(stored.seq)) return null;
    const outcome = decodeOutcome(stored.outcome);
    return outcome ? { seq: stored.seq, outcome } : null;
  }

  async keepOutcome(
    runId: string,
    seq: number,
    outcome: RunnerStepOutcome,
  ): Promise<void> {
    if (outcome.outcome === "dom" || outcome.outcome === "frame") return;
    await this.kv.setJson(`last.${runId}`, { seq, outcome });
  }

  /**
   * Note that a step is about to be executed, before it is. A worker that is
   * stopped between pressing a `submit` and keeping its outcome would otherwise
   * press it again when the step is claimed anew; a step found marked and
   * never answered is not repeated (see `pendingSeq`).
   */
  async markPending(runId: string, seq: number): Promise<void> {
    await this.kv.setJson(`last.${runId}`, { seq, pending: true });
  }

  /** The step this runner began and never recorded an outcome for, if any. */
  async pendingSeq(runId: string): Promise<number | null> {
    const stored = await this.kv.getJson(`last.${runId}`);
    if (!isJsonObject(stored) || stored.pending !== true) return null;
    return isNumber(stored.seq) ? stored.seq : null;
  }

  async forgetOutcome(runId: string): Promise<void> {
    await this.kv.remove(`last.${runId}`);
  }
}
