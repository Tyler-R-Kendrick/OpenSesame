import type { PendingRequest } from "./pending-request.js";
import { cliAppIntegrationPolicy } from "./policy-runtime.js";

export type EnsureStatus =
  | "approved"
  | "pending"
  | "denied"
  | "wrongSession"
  | "expired";

export interface ApprovedSession {
  terminalSessionId: string;
  approvedAtMs: number;
  lastActivityMs: number;
}

export interface EnsureResult {
  status: EnsureStatus;
  requestId?: string | undefined;
}

function nowMs(clock: () => number): number {
  return clock();
}

function idleExpired(session: ApprovedSession, clock: () => number): boolean {
  const idleMs = cliAppIntegrationPolicy.idleTimeoutSeconds * 1000;
  return nowMs(clock) - session.lastActivityMs > idleMs;
}

function hardExpired(session: ApprovedSession, clock: () => number): boolean {
  const hardMs = cliAppIntegrationPolicy.hardLimitSeconds * 1000;
  return nowMs(clock) - session.approvedAtMs > hardMs;
}

function pendingExpired(createdAtMs: number, clock: () => number): boolean {
  const ttlMs = cliAppIntegrationPolicy.requestTimeoutSeconds * 1000;
  return nowMs(clock) - createdAtMs > ttlMs;
}

const ENSURE_RATE_WINDOW_MS = 60_000;
const ENSURE_RATE_MAX = 8;
/** Oldest pending rows stay. A further distinct request is refused. */
const MAX_PENDING_REQUESTS = 8;

/** In-memory CLI app-integration state (daemon and unit tests). */
export class CliAppIntegrationStore {
  private approved = new Map<string, ApprovedSession>();
  private pending = new Map<string, PendingRequest>();
  private denied = new Set<string>();
  private ensureRate = new Map<string, number[]>();
  private nextRequest = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  touchApproved(terminalSessionId: string): void {
    const session = this.approved.get(terminalSessionId);
    if (!session) return;
    if (idleExpired(session, this.clock)) {
      this.approved.delete(terminalSessionId);
      return;
    }
    session.lastActivityMs = nowMs(this.clock);
  }

  ensure(
    terminalSessionId: string,
    verb: string,
    reference?: string | undefined,
  ): EnsureResult {
    this.expirePending();
    if (this.ensureRateLimited(terminalSessionId)) {
      return { status: "denied" };
    }
    if (this.denied.has(terminalSessionId)) {
      return { status: "denied" };
    }
    const session = this.approved.get(terminalSessionId);
    if (session) {
      if (hardExpired(session, this.clock)) {
        this.approved.delete(terminalSessionId);
        return { status: "expired" };
      }
      if (idleExpired(session, this.clock)) {
        this.approved.delete(terminalSessionId);
      } else {
        session.lastActivityMs = nowMs(this.clock);
        this.expireIdleExcept(terminalSessionId);
        return { status: "approved" };
      }
    }
    this.expireIdle();
    for (const row of this.pending.values()) {
      if (
        row.terminalSessionId === terminalSessionId &&
        row.verb === verb &&
        row.reference === reference
      ) {
        return { status: "pending", requestId: row.requestId };
      }
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return { status: "denied" };
    }
    const requestId = `clr_${++this.nextRequest}`;
    this.pending.set(requestId, {
      requestId,
      terminalSessionId,
      verb,
      reference,
      createdAtMs: nowMs(this.clock),
    });
    return { status: "pending", requestId };
  }

  listPending(): readonly PendingRequest[] {
    this.expireIdle();
    this.expirePending();
    const probe = cliAppIntegrationPolicy.daemonPinProbeVerb;
    return [...this.pending.values()]
      .filter((row) => row.verb !== probe)
      .sort((a, b) => {
        if (a.createdAtMs !== b.createdAtMs) {
          return a.createdAtMs - b.createdAtMs;
        }
        if (a.requestId < b.requestId) return -1;
        if (a.requestId > b.requestId) return 1;
        return 0;
      });
  }

  approve(requestId: string, terminalSessionId: string): EnsureResult {
    this.expireIdle();
    const row = this.pending.get(requestId);
    if (!row || row.terminalSessionId !== terminalSessionId) {
      return { status: "wrongSession" };
    }
    this.pending.delete(requestId);
    this.denied.delete(terminalSessionId);
    const at = nowMs(this.clock);
    this.approved.set(terminalSessionId, {
      terminalSessionId,
      approvedAtMs: at,
      lastActivityMs: at,
    });
    return { status: "approved" };
  }

  deny(requestId: string, terminalSessionId: string): EnsureResult {
    const row = this.pending.get(requestId);
    if (!row || row.terminalSessionId !== terminalSessionId) {
      return { status: "wrongSession" };
    }
    this.pending.delete(requestId);
    this.denied.add(terminalSessionId);
    this.approved.delete(terminalSessionId);
    return { status: "denied" };
  }

  checkApproved(terminalSessionId: string): EnsureStatus {
    this.expireIdle();
    const session = this.approved.get(terminalSessionId);
    if (!session) return "pending";
    if (idleExpired(session, this.clock)) {
      this.approved.delete(terminalSessionId);
      return "expired";
    }
    session.lastActivityMs = nowMs(this.clock);
    return "approved";
  }

  private expireIdle(): void {
    for (const [id, session] of this.approved) {
      if (
        idleExpired(session, this.clock) ||
        hardExpired(session, this.clock)
      ) {
        this.approved.delete(id);
      }
    }
  }

  private expireIdleExcept(keepTerminalSessionId: string): void {
    for (const [id, session] of this.approved) {
      if (id === keepTerminalSessionId) continue;
      if (
        idleExpired(session, this.clock) ||
        hardExpired(session, this.clock)
      ) {
        this.approved.delete(id);
      }
    }
  }

  private expirePending(): void {
    for (const [id, row] of this.pending) {
      if (pendingExpired(row.createdAtMs, this.clock)) {
        this.pending.delete(id);
      }
    }
  }

  private ensureRateLimited(terminalSessionId: string): boolean {
    const now = nowMs(this.clock);
    const windowStart = now - ENSURE_RATE_WINDOW_MS;
    const bucket = this.ensureRate.get(terminalSessionId) ?? [];
    const fresh = bucket.filter((t) => t >= windowStart);
    if (fresh.length >= ENSURE_RATE_MAX) {
      this.ensureRate.set(terminalSessionId, fresh);
      return true;
    }
    fresh.push(now);
    this.ensureRate.set(terminalSessionId, fresh);
    return false;
  }
}
