import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type {
  AgentRunControlState,
  AgentRunView,
  ClaimedRunnerStep,
  RunnerStepRequest,
} from "./agent-runs.js";

const CONTROL_STATES: readonly string[] = [
  "agent_driving",
  "handoff_requested",
  "awaiting_human",
  "human_driving",
  "resume_requested",
  "suspended",
];

/** One run's row, decoded. `null` when it is not shaped like a run. */
export function decodeAgentRun(value: BoundaryValue): AgentRunView | null {
  if (!isJsonObject(value)) return null;
  const { id, origin, control_state, quiescence, driver, closed_at } = value;
  const { expires_at, next_seq } = value;
  if (
    !isString(id) ||
    !isString(origin) ||
    !isString(control_state) ||
    !CONTROL_STATES.includes(control_state) ||
    !isString(expires_at) ||
    !isNumber(next_seq)
  ) {
    return null;
  }
  if (closed_at !== null && closed_at !== undefined && !isString(closed_at)) {
    return null;
  }
  // Checked against the closed list above.
  const state: AgentRunControlState = overlapCast(control_state);
  return {
    id,
    origin,
    control_state: state,
    quiescence: quiescence === "critical" ? "critical" : "quiescent",
    driver: driver === "human" ? "human" : "agent",
    closed_at: isString(closed_at) ? closed_at : null,
    expires_at,
    next_seq,
  };
}

/** The string members of each step whose members are all strings. */
const STRING_FIELDS = new Map([
  ["navigate", ["url"]],
  ["wait_for", ["selector"]],
  ["fill_credential", ["reference", "selector"]],
  ["assert_present", ["reference", "selector"]],
  ["submit", ["selector"]],
  ["verify_login", ["reference"]],
  ["capture_credential", ["slot", "selector", "recipient"]],
  ["capture_download", ["slot", "content_type", "recipient"]],
  ["generate_candidate", ["handle"]],
  ["seal_candidate", ["handle"]],
  ["promote_candidate", ["handle"]],
]);

/**
 * The step a claim carries, or `null` when it is not one this client knows.
 *
 * Strict in the way the Host is: a request with a tag this table does not hold,
 * a missing field, a field of the wrong type, or a field the step does not have
 * is not decoded at all, so a driver never acts on half of an instruction.
 */
export function decodeRunnerStepRequest(
  value: BoundaryValue,
): RunnerStepRequest | null {
  if (!isJsonObject(value) || !isString(value.step)) return null;
  const tag = value.step;
  const own = Object.keys(value).filter((key) => key !== "step");
  const exact = (names: readonly string[]) =>
    own.length === names.length && names.every((name) => name in value);
  const strings = STRING_FIELDS.get(tag);
  if (strings) return decodeStrings(value, strings, exact(strings));
  if (tag === "read_dom_redacted") return decodeStrip(value, exact(["strip"]));
  if (tag === "screenshot_redacted") {
    return decodeMask(value, exact(["epoch", "mask_selectors"]));
  }
  return null;
}

function decodeStrings(
  value: JsonObject,
  names: readonly string[],
  exact: boolean,
): RunnerStepRequest | null {
  if (!exact || !names.every((name) => isString(value[name]))) return null;
  // Every field the step has is present, a string, and the only one there.
  const typed: RunnerStepRequest = overlapCast(value);
  return typed;
}

function decodeStrip(
  value: JsonObject,
  exact: boolean,
): RunnerStepRequest | null {
  const strip = value.strip;
  if (!exact || !Array.isArray(strip) || !strip.every(isString)) return null;
  return { step: "read_dom_redacted", strip: strip.filter(isString) };
}

function decodeMask(
  value: JsonObject,
  exact: boolean,
): RunnerStepRequest | null {
  const { epoch, mask_selectors } = value;
  if (!exact || !isNumber(epoch) || !Number.isSafeInteger(epoch) || epoch < 0) {
    return null;
  }
  if (!Array.isArray(mask_selectors) || !mask_selectors.every(isString)) {
    return null;
  }
  return {
    step: "screenshot_redacted",
    epoch,
    mask_selectors: mask_selectors.filter(isString),
  };
}

/** A claim, decoded. `null` unless it is for `runId` and says no secrets were returned. */
export function decodeClaim(
  body: JsonObject,
  runId: string,
): ClaimedRunnerStep | null {
  const { run_id, seq, request, claim_expires_at, secrets_returned } = body;
  if (
    run_id !== runId ||
    !isNumber(seq) ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    !isJsonObject(request) ||
    // The Host says so on every claim; a response that does not is not one.
    !isBoolean(secrets_returned) ||
    secrets_returned
  ) {
    return null;
  }
  return {
    run_id,
    seq,
    request,
    claim_expires_at: isString(claim_expires_at) ? claim_expires_at : null,
  };
}
