import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { decodeAgentRun, decodeClaim } from "./agent-run-wire.js";
import type { HostRequestContext } from "./http.js";

/**
 * The driver's half of a sandboxed run (ADR 0079 §4, ADR 0081, ADR 0159): the
 * owner's own browser claims the run's outstanding step and settles what it
 * did. These types mirror `crates/rotation-web/src/extension.rs`
 * (`StepRequest` / `StepOutcome`) and `crates/gateway/src/web_login/custody.rs`
 * (the three custody steps). No request names a credential *value* and no
 * outcome has a field able to carry one.
 */

/** Why a step did not land. Mirrors `StepError`, snake_case on the wire. */
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

/** A run, as metadata. Never a frame, a rationale or a page. */
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

/** A step this caller holds a lease on. `request` is the raw wire object. */
export interface ClaimedRunnerStep {
  run_id: string;
  seq: number;
  request: JsonObject;
  claim_expires_at: string | null;
}

export interface SettledRunnerStep {
  status: "settled";
  /** Credential-shaped text was found and stored as a marker instead. */
  redacted: boolean;
  /** The organization's policy refused the outcome; it was stored as refused. */
  refused: boolean;
}

/** Where to read the run's hook records from, and how many. */
export interface HookRecordPage {
  after?: number;
  limit?: number;
}

/** A Host refusal, by status and stable code. Says nothing the driver sent. */
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

function runPath(id: string, suffix = ""): string {
  return `/api/v1/agent/runs/${encodeURIComponent(id)}${suffix}`;
}

async function failure(op: string, res: Response): Promise<RunnerApiError> {
  let code = "";
  try {
    const body = overlapCast(await res.json());
    if (isString(body?.error)) code = body.error;
  } catch {
    /* non-JSON error body */
  }
  return new RunnerApiError(op, res.status, code);
}

async function jsonBody(op: string, res: Response): Promise<JsonObject> {
  let body: BoundaryValue;
  try {
    body = await res.json();
  } catch {
    throw new RunnerApiError(op, res.status, "unreadable_response");
  }
  if (!isJsonObject(body)) {
    throw new RunnerApiError(op, res.status, "unexpected_response");
  }
  return body;
}

export function agentRunsApi(ctx: HostRequestContext) {
  return {
    /** The caller's own runs, newest first. Rows that do not decode are dropped. */
    async listAgentRuns(): Promise<AgentRunView[]> {
      const res = await ctx.request("/api/v1/agent/runs");
      if (!res.ok) throw await failure("agent_runs", res);
      const body = await jsonBody("agent_runs", res);
      const rows = Array.isArray(body.runs) ? body.runs : [];
      return rows.flatMap((row) => decodeAgentRun(row) ?? []);
    },

    async getAgentRun(id: string): Promise<AgentRunView> {
      const res = await ctx.request(runPath(id));
      if (!res.ok) throw await failure("agent_run", res);
      const run = decodeAgentRun(await jsonBody("agent_run", res));
      if (!run || run.id !== id)
        throw new RunnerApiError(
          "agent_run",
          res.status,
          "unexpected_response",
        );
      return run;
    },

    /**
     * Take the run's outstanding step. `null` when there is nothing to do or
     * another driver holds a live claim (204), so a polling driver has a cheap
     * answer rather than an error to interpret.
     */
    async claimRunnerStep(runId: string): Promise<ClaimedRunnerStep | null> {
      const res = await ctx.request(runPath(runId, "/steps/claim"), {
        method: "POST",
      });
      if (res.status === 204) return null;
      if (!res.ok) throw await failure("runner_step_claim", res);
      const claimed = decodeClaim(
        await jsonBody("runner_step_claim", res),
        runId,
      );
      if (!claimed) {
        throw new RunnerApiError(
          "runner_step_claim",
          res.status,
          "unexpected_response",
        );
      }
      return claimed;
    },

    /**
     * Report what a step did. The Host refuses an outcome that does not answer
     * the step or that carries a field the outcome does not have (422), and a
     * claim that lapsed (409); both surface as a [`RunnerApiError`].
     */
    async settleRunnerStep(
      runId: string,
      seq: number,
      outcome: RunnerStepOutcome,
    ): Promise<SettledRunnerStep> {
      const res = await ctx.request(
        runPath(runId, `/steps/${encodeURIComponent(String(seq))}/outcome`),
        { method: "POST", body: JSON.stringify({ outcome }) },
      );
      if (!res.ok) throw await failure("runner_step_settle", res);
      const body = await jsonBody("runner_step_settle", res);
      if (body.status !== "settled") {
        throw new RunnerApiError(
          "runner_step_settle",
          res.status,
          "unexpected_response",
        );
      }
      return {
        status: "settled",
        redacted: body.redacted === true,
        refused: body.refused === true,
      };
    },

    /** One page of the run's payload-free agent-hooks records (ADR 0159). */
    async readRunHookRecords(
      runId: string,
      page: HookRecordPage = {},
    ): Promise<BoundaryValue> {
      const query = new URLSearchParams();
      if (page.after !== undefined) query.set("after", String(page.after));
      if (page.limit !== undefined) query.set("limit", String(page.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return ctx.requestJson(
        "run_hook_records",
        runPath(runId, `/hook-records${suffix}`),
      );
    },
  };
}
