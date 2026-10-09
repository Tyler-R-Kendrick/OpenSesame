/**
 * One run, driven: claim its outstanding step, run it, settle what it did, and
 * stand down the moment the run is not the agent's to drive.
 */
import {
  type ClaimedRunnerStep,
  RunnerApiError,
  type RunnerStepOutcome,
  decodeRunnerStepRequest,
} from "@opensesame/api-client";
import type { AgentRunView } from "@opensesame/api-client";
import type { DriverDeps, EpochState } from "./context";
import { runStep } from "./driver";
import type {
  Connection,
  HostPort,
  RunnerDeps,
  TickReport,
} from "./loop-types";
import { skipReason } from "./readiness";
import { failed } from "./wire";

/** What a drive needs beyond the deps: a clock, the per-run epochs, and cleanup. */
export interface DriveEnv {
  deps: RunnerDeps;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  idleMs: number;
  epochs: Map<string, EpochState>;
  finish: (runId: string, origin: string) => Promise<void>;
}

/** `false` when the Host refused the settle: the step is not ours any more. */
async function settle(
  host: HostPort,
  runId: string,
  step: ClaimedRunnerStep,
  outcome: RunnerStepOutcome,
): Promise<boolean> {
  try {
    await host.settle(runId, step.seq, outcome);
    return true;
  } catch (error) {
    // A claim that lapsed, or an outcome the Host would not take. Stop; do not
    // retry what the Host refused. Anything else (the Host is down) is the
    // caller's to see, and the step is answered from what it did next time.
    if (
      error instanceof RunnerApiError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * What a claimed step is answered with. A step this runner already ran,
 * claimed again because its settle never arrived, is answered with what it
 * did, not run a second time.
 */
async function answer(
  env: DriveEnv,
  context: DriverDeps,
  step: ClaimedRunnerStep,
  run: AgentRunView,
): Promise<RunnerStepOutcome | null> {
  const request = decodeRunnerStepRequest(step.request);
  // A step this build does not know is not guessed at: nothing is run,
  // nothing is settled, and the lease lapses on the Host's clock.
  if (request === null) return null;
  const kept = await env.deps.settings.lastOutcome(run.id);
  if (kept?.seq === step.seq) return kept.outcome;
  // A submit is the one step that must never be pressed twice. A worker that
  // stopped after pressing it and before keeping its outcome finds it marked,
  // and answers that it did not land rather than pressing again.
  if (request.step === "submit") {
    const pending = await env.deps.settings.pendingSeq(run.id);
    if (pending === step.seq) return failed("transport");
    await env.deps.settings.markPending(run.id, step.seq);
  }
  const outcome = await runStep(request, context);
  await env.deps.settings.keepOutcome(run.id, step.seq, outcome);
  return outcome;
}

async function open(
  env: DriveEnv,
  run: AgentRunView,
  link: Connection,
): Promise<DriverDeps | null> {
  const { deps } = env;
  const pages = await deps.pagesFor({ id: run.id, origin: run.origin });
  if (!pages) return null;
  const held = (await deps.settings.active()).get(run.id);
  await deps.settings.markActive(run.id, {
    origin: run.origin,
    tabId: held?.tabId ?? null,
  });
  const epoch = env.epochs.get(run.id) ?? { epoch: 0, layout: null };
  env.epochs.set(run.id, epoch);
  const context: DriverDeps = {
    run: { id: run.id, origin: run.origin },
    pages,
    vault: deps.vault,
    backup: link.backup,
    epoch,
  };
  if (deps.loginWindowMs !== undefined) {
    context.loginWindowMs = deps.loginWindowMs;
  }
  if (deps.waitMs !== undefined) context.waitMs = deps.waitMs;
  return context;
}

export async function driveRun(
  env: DriveEnv,
  run: AgentRunView,
  link: Connection,
  report: TickReport,
): Promise<void> {
  const context = await open(env, run, link);
  if (!context) {
    report.skipped.push({ runId: run.id, reason: "no_page" });
    return;
  }
  report.driven.push(run.id);
  let idleSince = env.now();
  for (;;) {
    // Read fresh before every claim: a person may have asked for the page.
    const current = await link.host.getRun(run.id);
    const reason = await skipReason(env.deps, current, env.now());
    if (reason !== null) {
      report.skipped.push({ runId: run.id, reason });
      if (reason === "closed" || reason === "expired") {
        await env.finish(run.id, run.origin);
      }
      return;
    }
    const step = await link.host.claim(run.id);
    if (step === null) {
      if (env.now() - idleSince >= env.idleMs) return;
      await env.sleep(env.pollMs);
      continue;
    }
    idleSince = env.now();
    const outcome = await answer(env, context, step, run);
    if (outcome === null) {
      report.refused += 1;
      return;
    }
    if (!(await settle(link.host, run.id, step, outcome))) return;
    report.settled += 1;
  }
}
