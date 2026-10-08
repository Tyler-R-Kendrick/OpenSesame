/**
 * Runner wire types formerly exported from `@opensesame/api-client`.
 * The Host API is gone from this repo; tests and the wire layer keep the contract.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

export type RunnerStepError =
  | "timeout"
  | "no_such_element"
  | "navigation"
  | "challenge"
  | "transport"
  | "refused";

export type RunnerStepRequest =
  | { step: "navigate"; url: string }
  | { step: "wait_for"; selector: string }
  | { step: "fill_credential"; reference: string; selector: string }
  | { step: "assert_present"; reference: string; selector: string }
  | { step: "submit"; selector: string }
  | { step: "read_dom_redacted"; strip: string[] }
  | { step: "screenshot_redacted"; epoch: number; mask_selectors: string[] }
  | { step: "verify_login"; reference: string }
  | {
      step: "capture_credential";
      slot: string;
      selector: string;
      recipient: string;
    }
  | {
      step: "capture_download";
      slot: string;
      content_type: string;
      recipient: string;
    }
  | { step: "generate_candidate"; handle: string }
  | { step: "seal_candidate"; handle: string }
  | { step: "promote_candidate"; handle: string };

export type RunnerStepOutcome =
  | { outcome: "done" }
  | { outcome: "filled"; filled: "Ok" | "NoSuchField" }
  | { outcome: "presence"; presence: "Present" | "Absent" | "Mismatch" }
  | { outcome: "verified"; verified: "Works" | "Rejected" | "Indeterminate" }
  | { outcome: "dom"; text: string; epoch: number }
  | { outcome: "frame"; image: number[]; epoch: number; masked_boxes: number }
  | { outcome: "captured"; sealed: { recipient: string; envelope: string } }
  | { outcome: "sealed"; backed_up: boolean }
  | { outcome: "failed"; error: RunnerStepError };

export type AgentRunControlState =
  | "agent_driving"
  | "handoff_requested"
  | "awaiting_human"
  | "human_driving"
  | "resume_requested"
  | "suspended";

export interface AgentRunView {
  id: string;
  origin: string;
  control_state: AgentRunControlState;
  quiescence: "quiescent" | "critical";
  driver: "agent" | "human";
  closed_at: string | null;
  expires_at: string;
  next_seq: number;
}

export interface ClaimedRunnerStep {
  run_id: string;
  seq: number;
  request: JsonObject;
  claim_expires_at: string | null;
}

export interface SettledRunnerStep {
  status: "settled";
  redacted: boolean;
  refused: boolean;
}

export class RunnerApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(op: string, status: number, code: string) {
    super(code ? `${op}_failed:${status}:${code}` : `${op}_failed:${status}`);
    this.name = "RunnerApiError";
    this.status = status;
    this.code = code;
  }
}

export interface SyncPageCursor {
  epoch: number;
  id: string;
}

export interface SyncBlobView {
  id: string;
  ciphertext_b64: string;
}

export interface SyncReadPageResult {
  blobs: SyncBlobView[];
  has_more: boolean;
  next_after?: SyncPageCursor;
}

/** Minimal Host client surface the runner used; nothing here calls the network. */
export interface RunnerHostClient {
  syncReadPage(after: SyncPageCursor): Promise<SyncReadPageResult>;
  syncPush(
    blobs: Array<{ id: string; epoch: number; ciphertextB64: string }>,
  ): Promise<JsonObject>;
  listAgentRuns(): Promise<AgentRunView[]>;
  getAgentRun(id: string): Promise<AgentRunView>;
  claimRunnerStep(runId: string): Promise<ClaimedRunnerStep>;
  settleRunnerStep(
    runId: string,
    seq: number,
    outcome: RunnerStepOutcome,
  ): Promise<SettledRunnerStep>;
}

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
]);

const STRING_FIELDS = new Map<string, readonly string[]>([
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

function decodeStringFieldStep(
  value: JsonObject,
  tag: string,
  exact: (names: readonly string[]) => boolean,
): RunnerStepRequest | null {
  const strings = STRING_FIELDS.get(tag);
  if (!strings) return null;
  if (!exact(strings) || !strings.every((name) => isString(value[name]))) {
    return null;
  }
  // SAFETY: tag is in STRING_FIELDS and every named field is a string with exact keys only.
  return overlapCast(value);
}

function decodeReadDomRedacted(
  value: JsonObject,
  exact: (names: readonly string[]) => boolean,
): RunnerStepRequest | null {
  const strip = value.strip;
  if (!exact(["strip"]) || !Array.isArray(strip) || !strip.every(isString)) {
    return null;
  }
  return { step: "read_dom_redacted", strip: strip.filter(isString) };
}

function decodeScreenshotRedacted(
  value: JsonObject,
  exact: (names: readonly string[]) => boolean,
): RunnerStepRequest | null {
  const { epoch, mask_selectors } = value;
  if (
    !exact(["epoch", "mask_selectors"]) ||
    !isNumber(epoch) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !Array.isArray(mask_selectors) ||
    !mask_selectors.every(isString)
  ) {
    return null;
  }
  return {
    step: "screenshot_redacted",
    epoch,
    mask_selectors: mask_selectors.filter(isString),
  };
}

export function decodeRunnerStepRequest(
  value: BoundaryValue,
): RunnerStepRequest | null {
  if (!isJsonObject(value) || !isString(value.step)) return null;
  const tag = value.step;
  const own = Object.keys(value).filter((key) => key !== "step");
  const exact = (names: readonly string[]) =>
    own.length === names.length && names.every((name) => name in value);
  const stringStep = decodeStringFieldStep(value, tag, exact);
  if (stringStep) return stringStep;
  if (tag === "read_dom_redacted") {
    return decodeReadDomRedacted(value, exact);
  }
  if (tag === "screenshot_redacted") {
    return decodeScreenshotRedacted(value, exact);
  }
  return null;
}

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

export function normalizeLoopbackBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const isLoopbackV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (
    !LOOPBACK_HOSTS.has(host) &&
    !host.endsWith(".localhost") &&
    !isLoopbackV4
  ) {
    return null;
  }
  if (url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}
