import { kvGet, kvSet } from "./kv.js";

export type QueuedActionInput =
  | { kind: "device_approve"; userCode: string }
  | { kind: "claim_complete"; claimToken: string };

export type QueuedAction = QueuedActionInput & {
  id: string;
  createdAt: string;
  /** How many times a flush has tried and failed on this item. */
  attempts?: number;
};

const KEY = "outbox.v1";

/**
 * A queued ceremony is a short-lived intention. The tokens it carries expire on
 * their own; keeping the entry past that leaves a secret sitting in durable
 * storage with nothing left to do.
 */
export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

/** An outbox is a handful of pending ceremonies, not a log. */
export const MAX_QUEUE_LENGTH = 32;

/** After this many failures an item is dropped instead of blocking the ones behind it. */
export const MAX_ATTEMPTS = 5;

/**
 * Anything that can write our storage can write this list, and a flush turns each
 * entry into a privileged call. So read it as untrusted input: shape checked,
 * expired entries dropped, length bounded.
 */
function parseAction(value: unknown): QueuedAction | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") return null;
  if (typeof row.createdAt !== "string") return null;
  const createdAt = Date.parse(row.createdAt);
  if (Number.isNaN(createdAt)) return null;
  if (Date.now() - createdAt > QUEUE_TTL_MS) return null;
  const attempts =
    typeof row.attempts === "number" && row.attempts >= 0 ? row.attempts : 0;
  if (attempts >= MAX_ATTEMPTS) return null;
  const common = { id: row.id, createdAt: row.createdAt, attempts };
  if (
    row.kind === "device_approve" &&
    typeof row.userCode === "string" &&
    row.userCode !== ""
  ) {
    return { kind: "device_approve", userCode: row.userCode, ...common };
  }
  if (
    row.kind === "claim_complete" &&
    typeof row.claimToken === "string" &&
    row.claimToken.startsWith("osc_clm_")
  ) {
    return { kind: "claim_complete", claimToken: row.claimToken, ...common };
  }
  return null;
}

export function loadQueue(): QueuedAction[] {
  try {
    const raw = kvGet(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const kept: QueuedAction[] = [];
    for (const row of parsed) {
      const action = parseAction(row);
      if (action) kept.push(action);
    }
    return kept.slice(-MAX_QUEUE_LENGTH);
  } catch {
    return [];
  }
}

export function saveQueue(items: QueuedAction[]): void {
  kvSet(KEY, JSON.stringify(items.slice(-MAX_QUEUE_LENGTH)));
}

export function enqueue(action: QueuedActionInput): QueuedAction {
  const item: QueuedAction = {
    ...action,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  saveQueue([...loadQueue(), item]);
  return item;
}

export function dequeue(id: string): void {
  saveQueue(loadQueue().filter((a) => a.id !== id));
}

/** Record a failed attempt; the item drops itself once it has had enough. */
export function recordAttempt(id: string): void {
  saveQueue(
    loadQueue()
      .map((a) => (a.id === id ? { ...a, attempts: (a.attempts ?? 0) + 1 } : a))
      .filter((a) => (a.attempts ?? 0) < MAX_ATTEMPTS),
  );
}

/**
 * What may be shown about a queued claim. The token is `osc_clm_<id>.<secret>`, so
 * the tail is the half that must not appear on a screen or in a screenshot.
 */
export function claimTokenLabel(token: string): string {
  const [id] = token.split(".");
  return id ?? "osc_clm_…";
}
