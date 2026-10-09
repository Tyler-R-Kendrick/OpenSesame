/**
 * Resolve one token against the keymap in force (ADR 0156): counts are the
 * handler's, and this is the rest — the half-typed sequence, vim's
 * `timeoutlen`, and the rule that a stale prefix is swallowed, not
 * reinterpreted. Split out of `keymap.ts` to keep it inside the module-size
 * budget (ADR 0093).
 */
import {
  type ChordState,
  clearPending,
  continues,
  showPending,
} from "./keymap-chord.js";
import { isMotion } from "./keymap-commands.js";
import { listingOf } from "./keymap-targets.js";

export type Fire = (
  target: string,
  event: KeyboardEvent,
  keys: string[],
) => void;

/** What one resolution reads: the chord, what runs a target, the listing's keys. */
export type Resolver = Readonly<{
  chord: ChordState;
  fire: Fire;
  map: ReadonlyMap<string, string>;
  /** Vim's `timeoutlen`, read when the press lands. */
  timeoutMs: number;
}>;

/** `g V` reads as `g v`, as the section jumps always have. */
function sequenceOf(
  { chord, map }: Resolver,
  hadPrefix: boolean,
  token: string,
): string {
  const sequence = [...chord.pending, token].join(" ");
  if (
    hadPrefix &&
    !map.has(sequence) &&
    !continues(map, sequence) &&
    /^[A-Z]$/.test(token)
  ) {
    return [...chord.pending, token.toLowerCase()].join(" ");
  }
  return sequence;
}

/**
 * Wait for the next key of `sequence`. Once `timeoutMs` passes with nothing
 * longer, the shorter binding runs (vim's timeout); the statusline hears the
 * outcome whether or not that command threw.
 */
function waitForMore(
  resolver: Resolver,
  event: KeyboardEvent,
  sequence: string,
  exact: string | undefined,
): void {
  const { chord, fire, timeoutMs } = resolver;
  clearPending(chord);
  chord.pending = sequence.split(" ");
  chord.context = listingOf(event);
  chord.timer = setTimeout(() => {
    clearPending(chord);
    try {
      if (exact !== undefined) fire(exact, event, sequence.split(" "));
      else chord.count = 0;
    } finally {
      showPending(chord);
    }
  }, timeoutMs);
  event.preventDefault();
}

/**
 * Resolve `token` after whatever is pending; true when it was taken. The
 * keys in force are the listing's the press landed in (ADR 0156 §6).
 */
export function resolveToken(
  resolver: Resolver,
  event: KeyboardEvent,
  token: string,
): boolean {
  const { chord, fire, map } = resolver;
  const hadPrefix = chord.pending.length > 0;
  const sequence = sequenceOf(resolver, hadPrefix, token);
  const exact = map.get(sequence);
  if (continues(map, sequence)) {
    waitForMore(resolver, event, sequence, exact);
    return true;
  }
  clearPending(chord);
  if (exact !== undefined) {
    fire(exact, event, sequence.split(" "));
    event.preventDefault();
    return true;
  }
  if (!hadPrefix) return false;
  // A key that continues nothing is swallowed, not reinterpreted: a stale
  // `g y` must not become `y` (copy the secret) because the capability that
  // owned the jump left. A motion keeps its meaning after a prefix (`gk`).
  const fresh = map.get(token);
  if (token.length === 1 && !(fresh !== undefined && isMotion(fresh))) {
    chord.count = 0;
    event.preventDefault();
    return true;
  }
  return resolveToken(resolver, event, token);
}
