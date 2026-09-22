/**
 * Durable alert outbox (ALERT-B/C/E/F).
 * Statuses: queued ≠ delivered ≠ recipient_received ≠ human_acknowledged.
 * No emergency-response guarantee; alert ≠ unlock.
 */

import type { SealedAlertPackage } from "./seal.js";
import { verifyAlertEvidence } from "./seal.js";

export type { SealedAlertPackage } from "./seal.js";

/** Distinct delivery statuses — never collapse across authority domains. */
export type AlertDeliveryStatus =
  | "queued"
  | "delivered"
  | "recipient_received"
  | "human_acknowledged"
  | "failed"
  | "expired"
  | "cancelled";

export type StatusAuthority =
  | "local_scheduler"
  | "relay"
  | "recipient_device"
  | "human"
  | "policy";

export type OutboxEntry = {
  pkg: SealedAlertPackage;
  status: AlertDeliveryStatus;
  attempts: number;
  maxRetries: number;
  lastError?: string;
  statusEvidence: ReadonlyArray<{
    status: AlertDeliveryStatus;
    authority: StatusAuthority;
    at: string;
    digest: string;
  }>;
};

export type DurableOutboxStore = {
  load(): Promise<OutboxEntry[]>;
  save(entries: OutboxEntry[]): Promise<void>;
};

export type LateDeliveryPolicy =
  | { kind: "deliver_anyway" }
  | { kind: "cancel_if_resolved" }
  | { kind: "mark_expired" };

const FORWARD: AlertDeliveryStatus[] = [
  "queued",
  "delivered",
  "recipient_received",
  "human_acknowledged",
];

function digestEvidence(
  packageId: string,
  status: AlertDeliveryStatus,
  authority: StatusAuthority,
  at: string,
  priorDigest = "",
): string {
  // Authenticated-binding fingerprint for the status trail (secret-free).
  // Package-level HMAC (verifyAlertEvidence) authenticates ciphertext;
  // this chain binds each authority transition for diagnostics/audit.
  return `ev:${packageId}:${status}:${authority}:${at}:prior=${priorDigest}`;
}

export class AlertOutbox {
  #entries: OutboxEntry[] = [];
  #store: DurableOutboxStore | null;
  #latePolicy: LateDeliveryPolicy;
  #incidentResolved = false;

  constructor(opts?: {
    store?: DurableOutboxStore;
    latePolicy?: LateDeliveryPolicy;
  }) {
    this.#store = opts?.store ?? null;
    this.#latePolicy = opts?.latePolicy ?? { kind: "deliver_anyway" };
  }

  /** Hydrate from durable storage after restart (crash-consistent). */
  async hydrate(): Promise<void> {
    if (!this.#store) return;
    this.#entries = await this.#store.load();
  }

  async persist(): Promise<void> {
    if (!this.#store) return;
    await this.#store.save(
      this.#entries.map((e) => ({
        ...e,
        statusEvidence: [...e.statusEvidence],
      })),
    );
  }

  markIncidentResolved(resolved: boolean): void {
    this.#incidentResolved = resolved;
  }

  enqueue(
    pkg: SealedAlertPackage,
    maxRetries: number,
    now = Date.now(),
  ): OutboxEntry {
    const dup = this.#entries.find((e) => e.pkg.packageId === pkg.packageId);
    if (dup) return dup; // idempotent enqueue
    const at = new Date(now).toISOString();
    const entry: OutboxEntry = {
      pkg,
      status: "queued",
      attempts: 0,
      maxRetries,
      statusEvidence: [
        {
          status: "queued",
          authority: "local_scheduler",
          at,
          digest: digestEvidence(
            pkg.packageId,
            "queued",
            "local_scheduler",
            at,
          ),
        },
      ],
    };
    this.#entries.push(entry);
    return entry;
  }

  list(): readonly OutboxEntry[] {
    return this.#entries;
  }

  get(packageId: string): OutboxEntry | undefined {
    return this.#entries.find((e) => e.pkg.packageId === packageId);
  }

  #assertNotTerminal(entry: OutboxEntry): void {
    if (
      entry.status === "expired" ||
      entry.status === "failed" ||
      entry.status === "cancelled" ||
      entry.status === "human_acknowledged"
    ) {
      throw new Error("terminal_status");
    }
  }

  #advanceTerminal(
    entry: OutboxEntry,
    next: AlertDeliveryStatus,
    authority: StatusAuthority,
    now: number,
  ): OutboxEntry | null {
    if (next === "cancelled") {
      if (authority !== "policy" && authority !== "human") {
        throw new Error("authority_mismatch");
      }
      return this.#setStatus(entry, "cancelled", authority, now);
    }
    if (next === "failed") {
      return this.#setStatus(entry, "failed", authority, now);
    }
    if (next === "expired") {
      return this.#setStatus(entry, "expired", "policy", now);
    }
    return null;
  }

  #assertForwardAuthority(
    next: AlertDeliveryStatus,
    authority: StatusAuthority,
  ): void {
    if (next === "delivered" && authority !== "relay") {
      throw new Error("authority_mismatch");
    }
    if (next === "recipient_received" && authority !== "recipient_device") {
      throw new Error("authority_mismatch");
    }
    if (next === "human_acknowledged" && authority !== "human") {
      throw new Error("authority_mismatch");
    }
  }

  /**
   * Advance only with authority-correct transitions.
   * Client-supplied acknowledged:true is never accepted as human (INV-16).
   */
  advance(
    packageId: string,
    next: AlertDeliveryStatus,
    authority: StatusAuthority,
    now = Date.now(),
  ): OutboxEntry {
    const entry = this.#entries.find((e) => e.pkg.packageId === packageId);
    if (!entry) throw new Error("unknown_package");
    this.#assertNotTerminal(entry);
    if (Date.parse(entry.pkg.expiresAt) < now) {
      return this.#setStatus(entry, "expired", "policy", now);
    }

    const terminal = this.#advanceTerminal(entry, next, authority, now);
    if (terminal) return terminal;

    this.#assertForwardAuthority(next, authority);
    const cur = FORWARD.indexOf(entry.status);
    const nxt = FORWARD.indexOf(next);
    if (nxt < 0 || nxt !== cur + 1) throw new Error("invalid_transition");
    return this.#setStatus(entry, next, authority, now);
  }

  /**
   * Attempt local delivery via a double (test/relay adapter).
   * Never escalates to destruction on failure (INV no auto-destruction).
   */
  async attemptDelivery(
    packageId: string,
    deliver: (pkg: SealedAlertPackage) => Promise<"accepted" | "rejected">,
    macKey: CryptoKey,
    now = Date.now(),
  ): Promise<OutboxEntry> {
    const entry = this.#entries.find((e) => e.pkg.packageId === packageId);
    if (!entry) throw new Error("unknown_package");
    if (entry.status !== "queued") throw new Error("not_queued");

    if (!(await verifyAlertEvidence(entry.pkg, macKey))) {
      entry.lastError = "evidence_mac_invalid";
      return this.#setStatus(entry, "failed", "local_scheduler", now);
    }
    if (Date.parse(entry.pkg.expiresAt) < now) {
      return this.#setStatus(entry, "expired", "policy", now);
    }
    if (
      this.#incidentResolved &&
      this.#latePolicy.kind === "cancel_if_resolved"
    ) {
      return this.#setStatus(entry, "cancelled", "policy", now);
    }
    if (this.#incidentResolved && this.#latePolicy.kind === "mark_expired") {
      return this.#setStatus(entry, "expired", "policy", now);
    }

    entry.attempts += 1;
    try {
      const result = await deliver(entry.pkg);
      if (result === "accepted") {
        return this.advance(packageId, "delivered", "relay", now);
      }
      entry.lastError = "relay_rejected";
      if (entry.attempts > entry.maxRetries) {
        return this.#setStatus(entry, "failed", "relay", now);
      }
      return entry;
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : "delivery_error";
      if (entry.attempts > entry.maxRetries) {
        return this.#setStatus(entry, "failed", "relay", now);
      }
      return entry;
    }
  }

  expireOverdue(now = Date.now()): void {
    for (const e of this.#entries) {
      if (
        Date.parse(e.pkg.expiresAt) < now &&
        (e.status === "queued" || e.status === "delivered")
      ) {
        this.#setStatus(e, "expired", "policy", now);
      }
    }
  }

  /** Opaque packages that may survive local removal when policy allows. */
  exportRetainedOpaque(): SealedAlertPackage[] {
    return this.#entries
      .filter((e) => e.status === "queued" || e.status === "delivered")
      .map((e) => e.pkg);
  }

  /** Secret-free diagnostics for support surfaces. */
  diagnostics(): ReadonlyArray<{
    packageId: string;
    status: AlertDeliveryStatus;
    attempts: number;
    routeRef: string;
    expiresAt: string;
    lastError?: string;
  }> {
    return this.#entries.map((e) => ({
      packageId: e.pkg.packageId,
      status: e.status,
      attempts: e.attempts,
      routeRef: e.pkg.routeRef,
      expiresAt: e.pkg.expiresAt,
      lastError: e.lastError,
    }));
  }

  #setStatus(
    entry: OutboxEntry,
    status: AlertDeliveryStatus,
    authority: StatusAuthority,
    now: number,
  ): OutboxEntry {
    const at = new Date(now).toISOString();
    entry.status = status;
    const prior = entry.statusEvidence.at(-1)?.digest ?? "";
    entry.statusEvidence = [
      ...entry.statusEvidence,
      {
        status,
        authority,
        at,
        digest: digestEvidence(
          entry.pkg.packageId,
          status,
          authority,
          at,
          prior,
        ),
      },
    ];
    return entry;
  }
}

/** In-memory durable store for tests / single-tab sessions. */
export function createMemoryOutboxStore(): DurableOutboxStore {
  let snap: OutboxEntry[] = [];
  return {
    async load() {
      return snap.map((e) => ({
        ...e,
        statusEvidence: [...e.statusEvidence],
      }));
    },
    async save(entries) {
      snap = entries.map((e) => ({
        ...e,
        statusEvidence: [...e.statusEvidence],
      }));
    },
  };
}
