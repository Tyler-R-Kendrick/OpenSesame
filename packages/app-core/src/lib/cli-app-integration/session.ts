import { cliAppIntegrationPolicy } from "./policy.js";

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

export interface PendingRequest {
  requestId: string;
  terminalSessionId: string;
  verb: string;
  reference?: string | undefined;
  createdAtMs: number;
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

/** In-memory CLI app-integration state (daemon and unit tests). */
export class CliAppIntegrationStore {
  private approved = new Map<string, ApprovedSession>();
  private pending = new Map<string, PendingRequest>();
  private denied = new Set<string>();
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
    this.expireIdle();
    if (this.denied.has(terminalSessionId)) {
      return { status: "denied" };
    }
    const session = this.approved.get(terminalSessionId);
    if (session) {
      if (idleExpired(session, this.clock)) {
        this.approved.delete(terminalSessionId);
      } else {
        session.lastActivityMs = nowMs(this.clock);
        return { status: "approved" };
      }
    }
    const existing = [...this.pending.values()].find(
      (row) => row.terminalSessionId === terminalSessionId,
    );
    if (existing) {
      return { status: "pending", requestId: existing.requestId };
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
    return [...this.pending.values()];
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
      if (idleExpired(session, this.clock)) this.approved.delete(id);
    }
  }
}
