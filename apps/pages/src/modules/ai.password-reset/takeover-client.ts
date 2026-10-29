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
};

export type HookRecord = {
  sequence: number;
  interception_point: string;
  decision: string;
  reason?: string | null;
  recorded_at: string;
};

type Reply = { status: number; json: () => Promise<unknown> };

export type TakeoverDeps = {
  get: (path: string) => Promise<Reply>;
  post: (path: string, body?: unknown) => Promise<Reply>;
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

  async function expectRun(reply: Reply): Promise<AgentRun> {
    if (reply.status < 200 || reply.status >= 300)
      throw new Error("The run could not be reached on the Host.");
    return (await reply.json()) as AgentRun;
  }

  async function transition(
    runId: string,
    kind: ControlTransition,
    path: string,
  ): Promise<AgentRun> {
    const elevation = await deps.authorize(kind, runId);
    if (!elevation) throw new Error("Verification did not grant control.");
    return expectRun(await deps.post(`${base(runId)}/${path}`, { elevation }));
  }

  return {
    authenticate: () => deps.authenticate(),
    getRun: async (runId: string) => expectRun(await deps.get(base(runId))),
    requestHandoff: (runId: string) => transition(runId, "handoff", "handoff"),
    takeControl: (runId: string) => transition(runId, "take", "control"),
    release: (runId: string) => transition(runId, "release", "release"),
    claimStep: async (runId: string): Promise<ClaimedStep | null> => {
      const reply = await deps.post(`${base(runId)}/steps/claim`);
      if (reply.status === 204) return null;
      if (reply.status < 200 || reply.status >= 300)
        throw new Error("No step could be claimed.");
      return (await reply.json()) as ClaimedStep;
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
        const body = (await reply.json()) as {
          records?: HookRecord[];
          next_after?: number;
          has_more?: boolean;
        };
        if (!Array.isArray(body.records)) return records;
        records.push(...body.records);
        if (body.has_more !== true || typeof body.next_after !== "number")
          return records;
        after = body.next_after;
      }
      throw new Error("The run record exceeded the pagination bound.");
    },
  };
}

export type TakeoverClient = ReturnType<typeof createTakeoverClient>;

export function createHostTakeoverClient(): TakeoverClient {
  const wrap =
    (method: string) =>
    async (path: string, body?: unknown): Promise<Reply> => {
      const response = await hostFetch(path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      return { status: response.status, json: () => response.json() };
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
