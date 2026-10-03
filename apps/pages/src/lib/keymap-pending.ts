/**
 * What the keyboard has half-typed (ADR 0156): vim's `showcmd`. The shell's
 * handler publishes a count, a sequence prefix, a register key waiting for
 * its letter and a recording in progress; the statusline reads them here,
 * and which-key reads the prefix's continuations from the keymap in force.
 */
import type { KeymapCommand } from "@opensesame/app-core/lib/keymap/commands.js";
import type { KeymapContext } from "@opensesame/app-core/lib/keymap/context.js";
import { targetLabel } from "@opensesame/app-core/lib/keymap/effective.js";

export type PendingKeys = Readonly<{
  /** A count typed so far; 0 for none. */
  count: number;
  /** Tokens of a half-typed sequence, or the register key awaiting a letter. */
  keys: readonly string[];
  /** The listing the prefix was typed in: which-key reads that listing's keys. */
  context: KeymapContext | null;
  /** Which register key waits for its letter. */
  awaiting: "record" | "replay" | null;
  /** The register a recording goes into, or null. */
  recording: string | null;
  /** What a screen reader hears: a recording starting or stopping. */
  announcement: string;
}>;

export const NO_PENDING: PendingKeys = {
  count: 0,
  keys: [],
  context: null,
  awaiting: null,
  recording: null,
  announcement: "",
};

let current: PendingKeys = NO_PENDING;
const listeners = new Set<() => void>();

function same(a: PendingKeys, b: PendingKeys): boolean {
  return (
    a.count === b.count &&
    a.awaiting === b.awaiting &&
    a.recording === b.recording &&
    a.context === b.context &&
    a.announcement === b.announcement &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, index) => key === b.keys[index])
  );
}

/** Replace the snapshot; listeners hear only a real change. */
export function publishPending(next: PendingKeys): void {
  if (same(current, next)) return;
  current = next;
  for (const listener of listeners) listener();
}

export function pendingSnapshot(): PendingKeys {
  return current;
}

export function subscribePending(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether anything is half-typed or recording: the segment draws only then. */
export function hasPending(pending: PendingKeys): boolean {
  return (
    pending.count > 0 || pending.keys.length > 0 || pending.recording !== null
  );
}

export type Continuation = Readonly<{
  /** The next key. */
  key: string;
  /** What it runs, or null when it only leads to longer sequences. */
  label: string | null;
}>;

/** Which-key: every next key after `prefix` in `bindings`, in keymap order. */
export function continuationsOf(
  bindings: ReadonlyMap<string, string>,
  prefix: readonly string[],
  commands: readonly KeymapCommand[],
): Continuation[] {
  if (prefix.length === 0) return [];
  const head = `${prefix.join(" ")} `;
  const found = new Map<string, string | null>();
  for (const [sequence, target] of bindings) {
    if (!sequence.startsWith(head)) continue;
    const rest = sequence.slice(head.length).split(" ");
    const key = rest[0] ?? "";
    const label = rest.length === 1 ? targetLabel(target, commands) : null;
    if (!found.has(key) || label !== null) found.set(key, label);
  }
  return [...found].map(([key, label]) => ({ key, label }));
}
