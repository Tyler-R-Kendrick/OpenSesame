import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Sandboxed agent runs, and watching one (ADR 0081).
 *
 * The Host relays a run's observation log as ciphertext it cannot read. This
 * module fetches it and stops there: opening an entry needs the owner's viewer
 * key, which lives in the vault, so decryption belongs beside the vault rather
 * than in a transport module. What is here is the shape — the lanes, the
 * cursor, and the control verbs.
 *
 * Nothing here ever receives a credential. The run APIs carry metadata and
 * sealed bodies, and no field on either can hold a value.
 */

import { hostFetch } from "./identity.js";

/** Where a run's control lease sits. Mirrors `crates/session-observe`. */
export type ControlState =
  | "agent_driving"
  | "handoff_requested"
  | "awaiting_human"
  | "human_driving"
  | "resume_requested"
  | "suspended";

export type AgentRun = {
  id: string;
  jobId: string;
  /** The relying party. An origin, never an account. */
  origin: string;
  /** `t3` (deterministic, no model) or `t4` (agentic). */
  tier: string;
  controlState: ControlState;
  quiescence: string;
  handoffQueued: boolean;
  driver: "agent" | "human";
  leaseExpiresAt: string | null;
  /** Value-blind hint. Never a page body. */
  blockedReason: string | null;
  nextSeq: number;
  closedAt: string | null;
  version: number;
  updatedAt: string;
};

/** One entry in the sealed log. `sealedPayload` is base64 ciphertext. */
export type LogEntry = {
  seq: number;
  lane: "action" | "thought" | "frame";
  /** Thought lane only: the action this rationale precedes. */
  ofStep: number | null;
  /** Frame lane only: the layout generation it was composited under. */
  layoutEpoch: number | null;
  sealedPayload: string;
  recordedAt: string;
};

export type LogPage = {
  entries: LogEntry[];
  nextAfter: number;
  runNextSeq: number;
};

function optionalString(value: BoundaryValue): string | null {
  return isString(value) ? value : null;
}

function optionalNumber(value: BoundaryValue): number | null {
  return isNumber(value) ? value : null;
}

/** One JSON body, cast at the boundary after a runtime overlap check. */
function asObject(value: BoundaryValue): JsonObject {
  return isTypeofObject(value) && !Array.isArray(value) && value !== null
    ? overlapCast(value)
    : {};
}

function toRun(raw: JsonObject): AgentRun | null {
  const id = raw.id;
  const origin = raw.origin;
  const controlState = raw.control_state;
  if (!isString(id) || !isString(origin) || !isString(controlState))
    return null;
  return {
    id,
    jobId: isString(raw.job_id) ? raw.job_id : "",
    origin,
    tier: isString(raw.tier) ? raw.tier : "t4",
    controlState:
      /* SAFETY: the gateway's CHECK constraint owns this column, so the value
         is validated to the documented set at the contract boundary; an
         unrecognised string renders as itself rather than steering a
         decision. */
      controlState as ControlState,
    quiescence: isString(raw.quiescence) ? raw.quiescence : "quiescent",
    handoffQueued: isBoolean(raw.handoff_queued) ? raw.handoff_queued : false,
    driver: raw.driver === "human" ? "human" : "agent",
    leaseExpiresAt: optionalString(raw.lease_expires_at),
    blockedReason: optionalString(raw.blocked_reason),
    nextSeq: isNumber(raw.next_seq) ? raw.next_seq : 0,
    closedAt: optionalString(raw.closed_at),
    version: isNumber(raw.version) ? raw.version : 1,
    updatedAt: isString(raw.updated_at) ? raw.updated_at : "",
  };
}

function toEntry(raw: JsonObject): LogEntry | null {
  const seq = raw.seq;
  const lane = raw.lane;
  const sealed = raw.sealed_payload;
  if (!isNumber(seq) || !isString(lane) || !isString(sealed)) return null;
  if (lane !== "action" && lane !== "thought" && lane !== "frame") return null;
  return {
    seq,
    lane,
    ofStep: optionalNumber(raw.of_step),
    layoutEpoch: optionalNumber(raw.layout_epoch),
    sealedPayload: sealed,
    recordedAt: isString(raw.recorded_at) ? raw.recorded_at : "",
  };
}

/** Every run the signed-in person owns. */
export async function listRuns(): Promise<AgentRun[]> {
  const response = await hostFetch("/api/v1/agent/runs");
  if (!response.ok) throw new Error(`runs unavailable (${response.status})`);
  const body = asObject(await response.json());
  const runs = body.runs;
  if (!Array.isArray(runs)) return [];
  return runs
    .map((row) => toRun(asObject(row)))
    .filter((run): run is AgentRun => run !== null);
}

export async function readRun(runId: string): Promise<AgentRun | null> {
  const response = await hostFetch(
    `/api/v1/agent/runs/${encodeURIComponent(runId)}`,
  );
  if (!response.ok) return null;
  return toRun(asObject(await response.json()));
}

/**
 * One page of the log, from `after`.
 *
 * Live and replay are the same call at different cursors: pass the last
 * sequence held to tail, or -1 to read from the start (ADR 0081 §1).
 */
export async function readLog(runId: string, after: number): Promise<LogPage> {
  const response = await hostFetch(
    `/api/v1/agent/runs/${encodeURIComponent(runId)}/log?after=${after}`,
  );
  if (!response.ok) throw new Error(`log unavailable (${response.status})`);
  const raw = asObject(await response.json());
  const entries = Array.isArray(raw.entries)
    ? raw.entries
        .map((row) => toEntry(asObject(row)))
        .filter((entry): entry is LogEntry => entry !== null)
    : [];
  return {
    entries,
    nextAfter: isNumber(raw.next_after) ? raw.next_after : after,
    runNextSeq: isNumber(raw.run_next_seq) ? raw.run_next_seq : 0,
  };
}

async function act(runId: string, verb: string): Promise<JsonObject> {
  const response = await hostFetch(
    `/api/v1/agent/runs/${encodeURIComponent(runId)}/${verb}`,
    { method: "POST" },
  );
  const body = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(
      isString(body.hint) ? body.hint : `request failed (${response.status})`,
    );
  }
  return body;
}

/**
 * Ask the agent for the page.
 *
 * Returns whether the request was queued — which happens when the run is
 * between its candidate assertion and its submit, the one span that must not
 * be interrupted (ADR 0081 §6). Queued is reported rather than hidden: a
 * request that seems to vanish is one people press again.
 */
export async function requestHandoff(
  runId: string,
): Promise<"queued" | "accepted"> {
  const body = await act(runId, "handoff");
  return body.status === "queued" ? "queued" : "accepted";
}

/** Take the page. Only available once the run has parked. */
export async function takeControl(runId: string): Promise<AgentRun | null> {
  const body = await act(runId, "control");
  return toRun(body);
}

/** Hand the page back. Autonomy does not resume until the run re-asserts. */
export async function releaseControl(runId: string): Promise<AgentRun | null> {
  const body = await act(runId, "release");
  return toRun(body);
}

/** Whether a person may take the page from here. */
/**
 * The reads and ceremonies a screen performs, behind one object.
 *
 * A viewer takes its calls through this rather than importing the functions
 * directly, so a test supplies a working stand-in instead of rewriting the
 * module underneath the component. The seam is the same shape as the module's
 * own exports, so the production wiring is the identity.
 */
export const agentRunSeams = {
  listRuns,
  readRun,
  readLog,
  requestHandoff,
  takeControl,
  releaseControl,
};

export function canTakeControl(run: AgentRun): boolean {
  return (
    run.closedAt === null &&
    (run.controlState === "awaiting_human" || run.controlState === "suspended")
  );
}

/** Whether asking for the page is the next useful thing. */
export function canRequestHandoff(run: AgentRun): boolean {
  return (
    run.closedAt === null &&
    (run.controlState === "agent_driving" ||
      run.controlState === "handoff_requested")
  );
}

/** A person's sentence for where a run is. */
export function runSentence(run: AgentRun): string {
  if (run.closedAt !== null) return "Finished.";
  switch (run.controlState) {
    case "agent_driving":
      return run.quiescence === "critical"
        ? "Saving the new password. This step cannot be interrupted."
        : "Working.";
    case "handoff_requested":
      return run.handoffQueued
        ? "You asked for the page. It will hand over as soon as the save finishes."
        : "You asked for the page. It will hand over at the next step.";
    case "awaiting_human":
      return "Stopped and waiting for you.";
    case "human_driving":
      return "You have the page.";
    case "resume_requested":
      return "Checking the page before it carries on.";
    case "suspended":
      return "Parked. Your old password still works.";
    default:
      return "Unknown.";
  }
}
