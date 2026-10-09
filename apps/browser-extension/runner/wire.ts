/**
 * What the runner settles, in the exact shape the Host decodes
 * (`crates/gateway/src/routes/agent_runs/outcome.rs`).
 *
 * The Host decodes an outcome into its typed enum and stores the canonical
 * encoding of what it decoded, refusing one that differs: an unknown field at
 * any depth, a shape that is not canonical, or an outcome that does not answer
 * the step it was claimed for. So the runner builds every outcome here, from
 * closed constructors with no free-form member, and checks its own answer
 * against the same closed table before it is sent.
 *
 * No constructor takes a credential value and no outcome has a field to hold
 * one. `dom` carries page text, which is why it is the one outcome that is
 * also scrubbed of every value the runner knows (`redactKnown`).
 */
import type {
  RunnerStepError,
  RunnerStepOutcome,
} from "@opensesame/api-client";
import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export type { RunnerStepError, RunnerStepOutcome };

/** The outcome tag that answers each step; `failed` answers any of them. */
const ANSWERS = new Map<string, RunnerStepOutcome["outcome"]>([
  ["navigate", "done"],
  ["wait_for", "done"],
  ["submit", "done"],
  ["generate_candidate", "done"],
  ["promote_candidate", "done"],
  ["fill_credential", "filled"],
  ["assert_present", "presence"],
  ["read_dom_redacted", "dom"],
  ["screenshot_redacted", "frame"],
  ["verify_login", "verified"],
  ["capture_credential", "captured"],
  ["capture_download", "captured"],
  ["seal_candidate", "sealed"],
]);

/** Whether the step is one the Host can settle an outcome for at all. */
export function isKnownStep(step: string): boolean {
  return ANSWERS.has(step);
}

/** Whether `outcome` is one the step named `step` may be answered with. */
export function answers(step: string, outcome: RunnerStepOutcome): boolean {
  const expected = ANSWERS.get(step);
  return (
    expected !== undefined &&
    (outcome.outcome === expected || outcome.outcome === "failed")
  );
}

export const done = (): RunnerStepOutcome => ({ outcome: "done" });

export const failed = (error: RunnerStepError): RunnerStepOutcome => ({
  outcome: "failed",
  error,
});

export const filled = (landed: boolean): RunnerStepOutcome => ({
  outcome: "filled",
  filled: landed ? "Ok" : "NoSuchField",
});

export const presence = (
  state: "Present" | "Absent" | "Mismatch",
): RunnerStepOutcome => ({ outcome: "presence", presence: state });

export const verified = (
  state: "Works" | "Rejected" | "Indeterminate",
): RunnerStepOutcome => ({ outcome: "verified", verified: state });

export const sealed = (backedUp: boolean): RunnerStepOutcome => ({
  outcome: "sealed",
  backed_up: backedUp,
});

export const dom = (text: string, epoch: number): RunnerStepOutcome => ({
  outcome: "dom",
  text,
  epoch,
});

export const frame = (
  image: Uint8Array,
  epoch: number,
  maskedBoxes: number,
): RunnerStepOutcome => ({
  outcome: "frame",
  image: Array.from(image),
  epoch,
  masked_boxes: maskedBoxes,
});

const ERRORS = new Set<string>([
  "timeout",
  "no_such_element",
  "navigation",
  "challenge",
  "transport",
  "refused",
]);

function isError(value: string): value is RunnerStepError {
  return ERRORS.has(value);
}

/** The outcomes that answer with one of a closed set of words. */
function decodeVerdict(value: JsonObject): RunnerStepOutcome | null {
  const { outcome, filled: landed, presence: seen, verified: proof } = value;
  if (outcome === "filled" && (landed === "Ok" || landed === "NoSuchField")) {
    return filled(landed === "Ok");
  }
  if (
    outcome === "presence" &&
    (seen === "Present" || seen === "Absent" || seen === "Mismatch")
  ) {
    return presence(seen);
  }
  if (
    outcome === "verified" &&
    (proof === "Works" || proof === "Rejected" || proof === "Indeterminate")
  ) {
    return verified(proof);
  }
  return null;
}

/**
 * An outcome rebuilt from stored JSON through the constructors above, or null.
 * Only the outcomes that carry no page content are decoded (`dom` and `frame`
 * are never kept), and nothing the JSON held beyond their own members survives.
 */
export function decodeOutcome(value: BoundaryValue): RunnerStepOutcome | null {
  if (!isJsonObject(value)) return null;
  const { outcome, backed_up: backedUp, error } = value;
  if (outcome === "done") return done();
  if (outcome === "sealed")
    return isBoolean(backedUp) ? sealed(backedUp) : null;
  if (outcome === "failed") {
    return isString(error) && isError(error) ? failed(error) : null;
  }
  return decodeVerdict(value);
}

/** The Host stores at most this much of an outcome, JSON-encoded (1 MiB). */
export const MAX_OUTCOME_BYTES = 1 << 20;

export function encodedSize(outcome: RunnerStepOutcome): number {
  return new TextEncoder().encode(JSON.stringify(outcome)).length;
}

const REDACTED = "[redacted]";

/** `text` with every known value replaced, whole and in its JSON-escaped form. */
export function redactKnown(text: string, known: readonly string[]): string {
  let out = text;
  for (const value of known) {
    if (value.length === 0) continue;
    out = out.split(value).join(REDACTED);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) out = out.split(escaped).join(REDACTED);
    const entity = value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
    if (entity !== value) out = out.split(entity).join(REDACTED);
  }
  return out;
}

/**
 * The last check before an outcome leaves: it answers the step, it fits the
 * Host's bound, and the one member that carries page text holds no value the
 * runner knows. An outcome that fails any of the three is replaced with a
 * failure that says nothing about why.
 *
 * Only `dom.text` is scanned: every other member is an enum, a number or image
 * bytes, so a scan of their encoding would only match a short password against
 * the word `outcome`.
 */
export function guard(
  step: string,
  outcome: RunnerStepOutcome,
  known: readonly string[],
): RunnerStepOutcome {
  if (!answers(step, outcome)) return failed("transport");
  if (encodedSize(outcome) > MAX_OUTCOME_BYTES) return failed("transport");
  if (outcome.outcome === "dom") {
    const held = known.some(
      (value) => value.length > 0 && outcome.text.includes(value),
    );
    if (held) return failed("transport");
  }
  return outcome;
}
