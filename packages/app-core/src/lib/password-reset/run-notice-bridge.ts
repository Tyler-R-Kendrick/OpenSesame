/**
 * Bridges Host agent-run state into the notifications queue (and, through
 * notice arrivals, the toast stack). When a reset run parks for a person,
 * one tray notice with a Take over route arrives; when the run resumes or
 * ends, the notice is dismissed and the vault run phase follows the Host.
 *
 * Metadata only: run ids, control states, and the Host's blocked reason.
 * Never a password, candidate, link, or page body.
 */

import { appendStatusNotice, dismissNotice, listNotices } from "../notices.js";
import {
  listVaultResetRuns,
  setVaultResetRunPhase,
} from "./vault-run-tracker.js";

export type AgentRunView = {
  id: string;
  job_id?: string | null;
  control_state: string;
  blocked_reason?: string | null;
  closed_at?: string | null;
};

export type RotationJobView = {
  id: string;
  status?: string;
};

export type ResetRunNoticeDeps = {
  listAgentRuns: () => Promise<AgentRunView[]>;
  getRotationJob: (jobId: string) => Promise<RotationJobView | null>;
};

const PARKED = new Set(["awaiting_human", "handoff_requested", "suspended"]);

export function agentRunNoticeId(agentRunId: string): string {
  return `agent-run:${agentRunId}`;
}

export function takeoverRoute(agentRunId: string): string {
  return `/runs/${encodeURIComponent(agentRunId)}`;
}

export async function syncResetRunNotices(
  deps: ResetRunNoticeDeps,
  signal?: AbortSignal,
): Promise<void> {
  const tracked = listVaultResetRuns().filter((record) => record.runId);
  if (tracked.length === 0 || signal?.aborted) return;
  let runs: AgentRunView[];
  try {
    runs = await deps.listAgentRuns();
  } catch {
    return;
  }
  for (const record of tracked) {
    if (signal?.aborted) return;
    if (record.runId && record.phase !== "failed")
      await syncOne(deps, record, runs, signal);
  }
}

type TrackedRecord = ReturnType<typeof listVaultResetRuns>[number];

async function syncOne(
  deps: ResetRunNoticeDeps,
  record: TrackedRecord,
  runs: AgentRunView[],
  signal?: AbortSignal,
): Promise<void> {
  const agentRun = runs.find((run) => run.job_id === record.runId) ?? null;
  if (signal?.aborted) return;
  if (agentRun && !agentRun.closed_at && PARKED.has(agentRun.control_state)) {
    parkNotice(record, agentRun);
    return;
  }
  if (agentRun && !agentRun.closed_at) {
    dismissNotice(agentRunNoticeId(agentRun.id));
    if (record.phase === "needs-you")
      setVaultResetRunPhase(record.scope, record.itemId, "in-progress", null);
    return;
  }
  await settleFromJob(deps, record, agentRun, signal);
}

function parkNotice(record: TrackedRecord, agentRun: AgentRunView): void {
  const noticeId = agentRunNoticeId(agentRun.id);
  if (!listNotices().some((notice) => notice.id === noticeId)) {
    appendStatusNotice({
      id: noticeId,
      tone: "warn",
      title: "Password reset needs you",
      body:
        agentRun.blocked_reason ??
        "The agent is paused on the provider site. Take over the browser session to continue.",
    });
  }
  if (record.phase !== "needs-you")
    setVaultResetRunPhase(
      record.scope,
      record.itemId,
      "needs-you",
      agentRun.blocked_reason ?? "The reset needs you.",
    );
}

async function settleFromJob(
  deps: ResetRunNoticeDeps,
  record: TrackedRecord,
  agentRun: AgentRunView | null,
  signal?: AbortSignal,
): Promise<void> {
  const jobId = record.runId;
  if (!jobId) return;
  const job = await deps.getRotationJob(jobId).catch(() => null);
  if (signal?.aborted) return;
  if (job?.status !== "succeeded" && job?.status !== "failed") return;
  if (agentRun) dismissNotice(agentRunNoticeId(agentRun.id));
  if (job.status === "succeeded") {
    setVaultResetRunPhase(record.scope, record.itemId, "done", null);
  } else {
    setVaultResetRunPhase(
      record.scope,
      record.itemId,
      "failed",
      "The password reset did not complete.",
    );
    const noticeId = `password-reset:${jobId}:failed`;
    if (!listNotices().some((notice) => notice.id === noticeId)) {
      appendStatusNotice({
        id: noticeId,
        tone: "err",
        title: "Password reset failed",
        body: "The password reset did not complete. Review the vault item and try again.",
      });
    }
  }
}

/** Poll the Host until stopped. Overlapping syncs are skipped. */
export function startResetRunNoticeBridge(
  deps: ResetRunNoticeDeps,
  intervalMs = 5_000,
): () => void {
  let stopped = false;
  let inFlight = false;
  const controller = new AbortController();
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await syncResetRunNotices(deps, controller.signal);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    controller.abort();
    clearInterval(timer);
  };
}
