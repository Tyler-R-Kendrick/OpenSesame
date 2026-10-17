import type { PendingRequest } from "../cli-app-integration/pending-request.js";
import { cliAppIntegrationPolicy } from "../cli-app-integration/policy-runtime.js";

export type PeerEnsureStatus =
  | "approved"
  | "pending"
  | "denied"
  | "wrongSession"
  | "expired";

export interface PeerEnsureResult {
  status: PeerEnsureStatus;
  requestId?: string | undefined;
}

const ENSURE_RATE_WINDOW_MS = 60_000;
const ENSURE_RATE_MAX = 8;
const PENDING_CAP = 8;

export type PeerApprovalMode = "refuse" | "queue";

interface ApprovedPeerSession {
  peerSessionId: string;
  approvedAtMs: number;
  lastActivityMs: number;
}

/** In-browser approval queue for peer / live-session requests (no daemon). */
export class PeerApprovalQueue {
  private approved = new Map<string, ApprovedPeerSession>();
  private pending = new Map<string, PendingRequest>();
  private denied = new Set<string>();
  private ensureRate = new Map<string, number[]>();
  private nextRequest = 0;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly mode: PeerApprovalMode = "refuse",
  ) {}

  ensure(
    peerSessionId: string,
    verb: string,
    reference?: string | undefined,
  ): PeerEnsureResult {
    this.expirePending();
    this.refuseAmbiguousPending();
    if (this.ensureRateLimited(peerSessionId)) {
      return { status: "denied" };
    }
    if (this.denied.has(peerSessionId)) {
      return { status: "denied" };
    }
    const session = this.approved.get(peerSessionId);
    if (session) {
      if (this.hardExpired(session)) {
        this.approved.delete(peerSessionId);
        return { status: "expired" };
      }
      if (this.idleExpired(session)) {
        this.approved.delete(peerSessionId);
      } else {
        session.lastActivityMs = this.clock();
        this.expireIdleExcept(peerSessionId);
        return { status: "approved" };
      }
    }
    this.expireIdle();
    for (const row of this.pending.values()) {
      if (
        row.terminalSessionId === peerSessionId &&
        row.verb === verb &&
        row.reference === reference
      ) {
        return { status: "pending", requestId: row.requestId };
      }
    }
    return this.enqueue(peerSessionId, verb, reference);
  }

  listPending(): readonly PendingRequest[] {
    this.expirePending();
    this.refuseAmbiguousPending();
    const probe = cliAppIntegrationPolicy.daemonPinProbeVerb;
    return [...this.pending.values()].filter((row) => row.verb !== probe);
  }

  approve(requestId: string, peerSessionId: string): PeerEnsureResult {
    this.expireIdle();
    this.refuseAmbiguousPending();
    const row = this.pending.get(requestId);
    if (!row || row.terminalSessionId !== peerSessionId) {
      return { status: "wrongSession" };
    }
    this.pending.delete(requestId);
    this.denied.delete(peerSessionId);
    const at = this.clock();
    this.approved.set(peerSessionId, {
      peerSessionId,
      approvedAtMs: at,
      lastActivityMs: at,
    });
    return { status: "approved" };
  }

  deny(requestId: string, peerSessionId: string): PeerEnsureResult {
    const row = this.pending.get(requestId);
    if (!row || row.terminalSessionId !== peerSessionId) {
      return { status: "wrongSession" };
    }
    this.pending.delete(requestId);
    this.denied.add(peerSessionId);
    this.approved.delete(peerSessionId);
    return { status: "denied" };
  }

  private refuseAmbiguousPending(): void {
    if (this.mode === "queue") return;
    if (this.pending.size > 1) this.pending.clear();
  }

  /** Queue mode keeps every pending peer, up to the cap. It never drops them. */
  private enqueue(
    peerSessionId: string,
    verb: string,
    reference: string | undefined,
  ): PeerEnsureResult {
    if (this.mode === "queue" && this.pending.size >= PENDING_CAP) {
      return { status: "denied" };
    }
    const requestId = `pr_${++this.nextRequest}`;
    this.pending.set(requestId, {
      requestId,
      terminalSessionId: peerSessionId,
      verb,
      reference,
      createdAtMs: this.clock(),
    });
    return { status: "pending", requestId };
  }

  private ensureRateLimited(peerSessionId: string): boolean {
    const now = this.clock();
    const windowStart = now - ENSURE_RATE_WINDOW_MS;
    const bucket = this.ensureRate.get(peerSessionId) ?? [];
    const fresh = bucket.filter((t) => t >= windowStart);
    if (fresh.length >= ENSURE_RATE_MAX) {
      this.ensureRate.set(peerSessionId, fresh);
      return true;
    }
    fresh.push(now);
    this.ensureRate.set(peerSessionId, fresh);
    return false;
  }

  private idleExpired(session: ApprovedPeerSession): boolean {
    const idleMs = cliAppIntegrationPolicy.idleTimeoutSeconds * 1000;
    return this.clock() - session.lastActivityMs > idleMs;
  }

  private hardExpired(session: ApprovedPeerSession): boolean {
    const hardMs = cliAppIntegrationPolicy.hardLimitSeconds * 1000;
    return this.clock() - session.approvedAtMs > hardMs;
  }

  private expireIdle(): void {
    for (const [id, session] of this.approved) {
      if (this.idleExpired(session) || this.hardExpired(session)) {
        this.approved.delete(id);
      }
    }
  }

  private expireIdleExcept(keep: string): void {
    for (const [id, session] of this.approved) {
      if (id === keep) continue;
      if (this.idleExpired(session) || this.hardExpired(session)) {
        this.approved.delete(id);
      }
    }
  }

  private expirePending(): void {
    const ttlMs = cliAppIntegrationPolicy.requestTimeoutSeconds * 1000;
    const now = this.clock();
    for (const [id, row] of this.pending) {
      if (now - row.createdAtMs > ttlMs) {
        this.pending.delete(id);
      }
    }
  }
}
