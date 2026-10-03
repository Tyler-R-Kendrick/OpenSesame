import {
  type AgentRunView,
  type ClaimedRunnerStep,
  RunnerApiError,
  type RunnerStepOutcome,
  type SettledRunnerStep,
} from "@opensesame/api-client";
/**
 * A fake Host that is as strict as the real one about what a driver settles.
 *
 * `settle` mirrors `crates/gateway/src/routes/agent_runs/outcome.rs`: the
 * outcome must be one the pending step may be answered with, must have exactly
 * that outcome's fields at every depth, and is refused (422) otherwise. A claim
 * is a lease held by one caller, and a step that is not the caller's live claim
 * is refused (409). Run state is the lease machine's wire names, so a test can
 * hand the page to a person and watch the runner stand down.
 *
 * It also stands in for the Host's ciphertext store, which is what a candidate's
 * backup is put in and read back from.
 */
import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import type { BackupStore } from "../backup";
import { toB64 } from "../bytes";
import type { HostPort } from "../loop";

const ANSWERS = new Map([
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

const ERRORS = [
  "timeout",
  "no_such_element",
  "navigation",
  "challenge",
  "transport",
  "refused",
];

function members(o: JsonObject, own: string[]): boolean {
  const found = Object.keys(o)
    .filter((key) => key !== "outcome")
    .sort();
  return JSON.stringify(found) === JSON.stringify([...own].sort());
}

function uint(v: BoundaryValue | undefined): boolean {
  return isNumber(v ?? null) && Number.isInteger(v) && Number(v) >= 0;
}

function oneOf(value: BoundaryValue | undefined, allowed: string[]): boolean {
  return allowed.includes(String(value));
}

/** What makes an outcome canonical, by its tag: its members and their legal values. */
const CANONICAL = new Map<string, (o: JsonObject) => boolean>([
  ["done", (o) => members(o, [])],
  [
    "filled",
    (o) => members(o, ["filled"]) && oneOf(o.filled, ["Ok", "NoSuchField"]),
  ],
  [
    "presence",
    (o) =>
      members(o, ["presence"]) &&
      oneOf(o.presence, ["Present", "Absent", "Mismatch"]),
  ],
  [
    "verified",
    (o) =>
      members(o, ["verified"]) &&
      oneOf(o.verified, ["Works", "Rejected", "Indeterminate"]),
  ],
  [
    "dom",
    (o) =>
      members(o, ["text", "epoch"]) &&
      isString(o.text ?? null) &&
      uint(o.epoch),
  ],
  [
    "frame",
    (o) =>
      members(o, ["image", "epoch", "masked_boxes"]) &&
      Array.isArray(o.image) &&
      o.image.every((b) => uint(b) && Number(b) < 256) &&
      uint(o.epoch) &&
      uint(o.masked_boxes),
  ],
  ["captured", (o) => members(o, ["sealed"])],
  [
    "sealed",
    (o) => members(o, ["backed_up"]) && isBoolean(o.backed_up ?? null),
  ],
  ["failed", (o) => members(o, ["error"]) && oneOf(o.error, ERRORS)],
]);

/** The refusal the real route would give an outcome, or null when it is canonical. */
export function refusalFor(
  step: string,
  outcome: BoundaryValue,
): [number, string] | null {
  const expected = ANSWERS.get(step);
  if (expected === undefined) return [409, "unknown_step"];
  if (!isJsonObject(outcome)) return [422, "invalid_outcome"];
  const tag = outcome.outcome;
  if (!isString(tag)) return [422, "invalid_outcome"];
  if (tag !== expected && tag !== "failed") return [422, "wrong_outcome"];
  return CANONICAL.get(tag)?.(outcome) ? null : [422, "invalid_outcome"];
}

interface Row {
  view: AgentRunView;
  owner: string;
}

interface Pending {
  seq: number;
  request: JsonObject;
  state: "pending" | "claimed" | "settled";
  claimedBy: string | null;
  outcome: RunnerStepOutcome | null;
  waiter: (outcome: RunnerStepOutcome | null) => void;
}

export interface Settled {
  runId: string;
  seq: number;
  request: JsonObject;
  outcome: BoundaryValue;
}

export class FakeHost implements HostPort, BackupStore {
  private readonly rows = new Map<string, Row>();
  private readonly steps = new Map<string, Pending[]>();
  readonly settled: Settled[] = [];
  readonly refused: { runId: string; status: number; code: string }[] = [];
  claims = 0;
  /** The sync store a backup is put in. */
  readonly blobs = new Map<string, Uint8Array>();
  rejectPushes = false;
  tamperOnRead = false;

  constructor(readonly me = "principal:me") {}

  openRun(id: string, origin: string, owner = this.me): void {
    this.rows.set(id, {
      owner,
      view: {
        id,
        origin,
        control_state: "agent_driving",
        quiescence: "quiescent",
        driver: "agent",
        closed_at: null,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        next_seq: 0,
      },
    });
    this.steps.set(id, []);
  }

  /** A person asks for the page; the Host's lease machine moves the run on. */
  handOff(
    id: string,
    state: AgentRunView["control_state"] = "handoff_requested",
  ): void {
    const row = this.rows.get(id);
    if (row) row.view = { ...row.view, control_state: state };
  }

  takeControl(id: string): void {
    const row = this.rows.get(id);
    if (row) {
      row.view = {
        ...row.view,
        control_state: "human_driving",
        driver: "human",
      };
    }
  }

  close(id: string): void {
    const row = this.rows.get(id);
    if (row) row.view = { ...row.view, closed_at: new Date().toISOString() };
  }

  /** A claim's lease runs out: the step is up for claiming again. */
  lapse(runId: string): void {
    for (const step of this.steps.get(runId) ?? []) {
      if (step.state === "claimed") {
        step.state = "pending";
        step.claimedBy = null;
      }
    }
  }

  /** The executor's half: enqueue a step and wait for what was settled. */
  dispatch(runId: string, request: JsonObject, timeoutMs = 5_000) {
    const list = this.steps.get(runId) ?? [];
    return new Promise<RunnerStepOutcome | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      list.push({
        seq: list.length,
        request,
        state: "pending",
        claimedBy: null,
        outcome: null,
        waiter: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      });
      this.steps.set(runId, list);
    });
  }

  private owned(id: string): Row {
    const row = this.rows.get(id);
    if (!row || row.owner !== this.me)
      throw new RunnerApiError("run", 404, "not_found");
    return row;
  }

  async listRuns() {
    return [...this.rows.values()]
      .filter((r) => r.owner === this.me)
      .map((r) => r.view);
  }

  async getRun(id: string) {
    return this.owned(id).view;
  }

  async claim(runId: string): Promise<ClaimedRunnerStep | null> {
    this.owned(runId);
    this.claims += 1;
    const next = (this.steps.get(runId) ?? []).find(
      (s) => s.state === "pending",
    );
    if (!next) return null;
    next.state = "claimed";
    next.claimedBy = this.me;
    return {
      run_id: runId,
      seq: next.seq,
      request: JSON.parse(JSON.stringify(next.request)),
      claim_expires_at: null,
    };
  }

  async settle(
    runId: string,
    seq: number,
    outcome: RunnerStepOutcome,
  ): Promise<SettledRunnerStep> {
    this.owned(runId);
    const step = (this.steps.get(runId) ?? [])[seq];
    const refuse = (status: number, code: string): never => {
      this.refused.push({ runId, status, code });
      throw new RunnerApiError("runner_step_settle", status, code);
    };
    if (!step || step.state !== "claimed" || step.claimedBy !== this.me) {
      refuse(409, "not_the_claimant");
    }
    // Round-tripped through JSON: what the Host sees is what was encoded.
    const wire: BoundaryValue = JSON.parse(JSON.stringify(outcome));
    const refusal = refusalFor(String(step?.request.step), wire);
    if (refusal) refuse(refusal[0], refusal[1]);
    if (step) {
      step.state = "settled";
      step.outcome = outcome;
      this.settled.push({ runId, seq, request: step.request, outcome: wire });
      step.waiter(outcome);
    }
    return { status: "settled", redacted: false, refused: false };
  }

  /** Whether any settled outcome carries `secret`, anywhere in its encoding. */
  leaks(secret: string): boolean {
    return this.settled.some((row) =>
      JSON.stringify(row.outcome).includes(secret),
    );
  }

  // --- the ciphertext store -------------------------------------------------

  async push(id: string, bytes: Uint8Array) {
    if (this.rejectPushes) return false;
    this.blobs.set(id, bytes);
    return true;
  }

  async confirm(id: string, bytes: Uint8Array) {
    const held = this.blobs.get(id);
    if (!held) return false;
    const read = this.tamperOnRead ? new Uint8Array([...held, 0]) : held;
    return toB64(read) === toB64(bytes);
  }
}
