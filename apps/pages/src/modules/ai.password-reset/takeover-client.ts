/**
 * Browser takeover client for a Host agent run (ADR 0081): observe the run,
 * ask for the page, take it with a step-up passkey elevation, answer the
 * steps a person can truthfully answer from here, and hand the page back so
 * the runner re-asserts and resumes. No secret ever crosses this client —
 * step requests name credential references and selectors, never values.
 */

import { currentBrowserGrant } from "@opensesame/app-core/lib/browser-pairing.js";
import {
  type ControlTransition,
  authorizeHost,
} from "@opensesame/app-core/lib/host-authorization.js";
import { hostBase, hostFetch } from "@opensesame/app-core/lib/identity.js";
import type { JsonValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  hostAgentRunSchema,
  hostClaimedStepSchema,
  hostHandoffReceiptSchema,
  hostHookRecordSchema,
  hostHookRecordsSchema,
} from "./host-run-schemas.js";

export type AgentRun = {
  id: string;
  job_id?: string | null;
  origin?: string;
  control_state: string;
  driver?: string;
  blocked_reason?: string | null;
  lease_expires_at?: string | null;
  closed_at?: string | null;
  observation?: string;
};

export type ClaimedStep = {
  run_id: string;
  seq: number;
  request: { step?: string; selector?: string; url?: string } & Record<
    string,
    unknown
  >;
  claim_expires_at?: string | null;
};

/** A lapsed claim cannot settle; it must be reacquired first. */
export function claimExpired(step: ClaimedStep, now = Date.now()): boolean {
  if (!step.claim_expires_at) return false;
  const expires = Date.parse(step.claim_expires_at);
  return Number.isFinite(expires) && expires <= now;
}

export type HookRecord = {
  sequence: number;
  interception_point: string;
  decision: string;
  reason?: string | null;
  recorded_at: string;
};

type Reply = { status: number; json: () => Promise<JsonValue> };

export type TakeoverDeps = {
  get: (path: string) => Promise<Reply>;
  post: (path: string, body?: JsonValue) => Promise<Reply>;
  authenticate: () => Promise<void>;
  authorize: (
    transition: ControlTransition,
    runId: string,
  ) => Promise<string | null>;
};

export type TakeoverAction = "handoff" | "take" | "release" | "claim";

const PARKED = new Set(["awaiting_human", "suspended"]);

export function takeoverActions(run: AgentRun): TakeoverAction[] {
  if (run.closed_at) return [];
  if (PARKED.has(run.control_state)) return ["take"];
  if (run.control_state === "human_driving") return ["release", "claim"];
  if (["handoff_requested", "resume_requested"].includes(run.control_state))
    return [];
  return ["handoff"];
}

/** The outcome tag a step may be answered with (besides `failed`). */
export function expectedOutcome(step: string | undefined): string | null {
  switch (step) {
    case "navigate":
    case "wait_for":
    case "submit":
      return "done";
    case "fill_credential":
      return "filled";
    case "assert_present":
      return "presence";
    case "read_dom_redacted":
      return "dom";
    case "screenshot_redacted":
      return "frame";
    case "verify_login":
      return "verified";
    case "capture_credential":
    case "capture_download":
      return "captured";
    default:
      return null;
  }
}

/** Outcomes this panel can report without fabricating page payloads. */
const REPORTABLE = new Set(["done", "failed"]);

export function createTakeoverClient(deps: TakeoverDeps) {
  const base = (runId: string) =>
    `/api/v1/agent/runs/${encodeURIComponent(runId)}`;

  async function expectRun(reply: Reply, runId: string): Promise<AgentRun> {
    if (reply.status < 200 || reply.status >= 300)
      throw new Error("The run could not be reached on the Host.");
    const run = hostAgentRunSchema.parse(await reply.json());
    if (run.id !== runId) throw new Error("The Host returned a different run.");
    return run;
  }

  async function transition(
    runId: string,
    kind: ControlTransition,
    path: string,
  ): Promise<AgentRun> {
    const elevation = await deps.authorize(kind, runId);
    if (!elevation) throw new Error("Verification did not grant control.");
    return expectRun(
      await deps.post(`${base(runId)}/${path}`, { elevation }),
      runId,
    );
  }

  return {
    authenticate: () => deps.authenticate(),
    getRun: async (runId: string) =>
      expectRun(await deps.get(base(runId)), runId),
    requestHandoff: async (runId: string) => {
      const elevation = await deps.authorize("handoff", runId);
      if (!elevation) throw new Error("Verification did not grant control.");
      const reply = await deps.post(`${base(runId)}/handoff`, { elevation });
      if (reply.status !== 202)
        throw new Error("The handoff could not be requested on the Host.");
      return hostHandoffReceiptSchema.parse(await reply.json());
    },
    takeControl: (runId: string) => transition(runId, "take", "control"),
    release: (runId: string) => transition(runId, "release", "release"),
    claimStep: async (runId: string): Promise<ClaimedStep | null> => {
      const reply = await deps.post(`${base(runId)}/steps/claim`);
      if (reply.status === 204) return null;
      if (reply.status < 200 || reply.status >= 300)
        throw new Error("No step could be claimed.");
      const step = hostClaimedStepSchema.parse(await reply.json());
      if (step.run_id !== runId)
        throw new Error("The Host returned a step from a different run.");
      return step;
    },
    settleStep: async (
      runId: string,
      seq: number,
      outcome: { outcome: string; error?: string },
    ): Promise<void> => {
      if (!REPORTABLE.has(outcome.outcome))
        throw new Error(
          "This panel cannot report that outcome; it never invents page payloads.",
        );
      const reply = await deps.post(`${base(runId)}/steps/${seq}/outcome`, {
        outcome,
      });
      if (reply.status < 200 || reply.status >= 300)
        throw new Error("The Host refused that outcome.");
    },
    listHookRecords: async (runId: string): Promise<HookRecord[]> => {
      const records: HookRecord[] = [];
      let after: number | null = null;
      for (let page = 0; page < 100; page += 1) {
        const cursor = after === null ? "" : `&after=${after}`;
        const reply = await deps.get(
          `${base(runId)}/hook-records?limit=20${cursor}`,
        );
        if (reply.status < 200 || reply.status >= 300) return records;
        const parsed = hostHookRecordsSchema.safeParse(await reply.json());
        if (!parsed.success || parsed.data.run_id !== runId) return records;
        const body = parsed.data;
        for (const entry of body.records) {
          const parsedRecord = hostHookRecordSchema.safeParse(entry);
          if (parsedRecord.success) records.push(parsedRecord.data);
        }
        const next = z.number().safeParse(body.next_after);
        if (body.has_more !== true || !next.success) return records;
        after = next.data;
      }
      throw new Error("The run record exceeded the pagination bound.");
    },
  };
}

export type TakeoverClient = ReturnType<typeof createTakeoverClient>;

export function createHostTakeoverClient(): TakeoverClient {
  const wrap =
    (method: string) =>
    async (path: string, body?: JsonValue): Promise<Reply> => {
      const options: RequestInit = { method };
      if (body !== undefined) {
        options.headers = { "content-type": "application/json" };
        options.body = JSON.stringify(body);
      }
      const response = await hostFetch(path, options);
      return {
        status: response.status,
        json: async () => z.json().parse(await response.json()),
      };
    };
  return createTakeoverClient({
    get: wrap("GET"),
    post: wrap("POST"),
    authenticate: async () => {
      const grant = currentBrowserGrant(hostBase());
      if (!grant) throw new Error("This browser has no approved Host grant.");
      await authorizeHost(
        {
          operation: "browser.authenticate",
          target_id: grant.clientId,
          transition: null,
        },
        new AbortController().signal,
      );
    },
    authorize: (transition, runId) =>
      authorizeHost(
        { operation: "agent.browser.control", target_id: runId, transition },
        new AbortController().signal,
      ),
  });
}
