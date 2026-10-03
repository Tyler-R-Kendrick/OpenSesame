/**
 * The runner's loop: which runs it may drive, and when it stops.
 *
 * It claims a step only for a run that is the person's, is the agent's to
 * drive right now, is for an origin the person armed *and* the browser still
 * lets this extension act on, and for which everything a step will need is
 * already in place. Each of those is read fresh before every claim:
 *
 * - **Ownership.** The Host lists only the caller's own runs (a run belongs to
 *   whoever's credential it rotates), and a run that is not in that list is not
 *   claimed. The Host re-checks on the claim itself.
 * - **Handoff and pause.** A run whose control state is anything but
 *   `agent_driving`, or whose driver is a person, is one a person holds or has
 *   asked for. The runner sends nothing and claims nothing; autonomy is never
 *   resumed from here (ADR 0081 §6-§7). The page is left exactly as it is.
 * - **Readiness.** A credential for the origin, a recovery recipient to back a
 *   candidate up to, and a private context to prove the login in. Without them
 *   a run would reach its submit and be unable to finish it, so it is not
 *   started.
 */
import type { EpochState } from "./context";
import { type DriveEnv, driveRun } from "./drive";
import type { RunnerDeps, TickReport } from "./loop-types";
import { skipReason } from "./readiness";

export type {
  Connection,
  HostPort,
  RunnerDeps,
  Skip,
  TickReport,
} from "./loop-types";

const MAX_RUNS_PER_TICK = 3;

export function createRunner(deps: RunnerDeps) {
  const now = deps.now ?? Date.now;
  const epochs = new Map<string, EpochState>();
  let busy: Promise<TickReport> | null = null;

  /** Give a finished run's page and grant back. */
  async function finish(runId: string, origin: string): Promise<void> {
    epochs.delete(runId);
    const held = (await deps.settings.active()).get(runId);
    await deps.closePage(held?.tabId ?? null).catch(() => undefined);
    await deps.settings.clearActive(runId);
    await deps.settings.forgetOutcome(runId);
    const stillOpen = [...(await deps.settings.active()).values()].some(
      (other) => other.origin === origin,
    );
    if (!stillOpen) {
      await deps.settings.disarm(origin);
      await deps.grants.revoke(origin);
    }
  }

  const env: DriveEnv = {
    deps,
    now,
    sleep:
      deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    pollMs: deps.pollMs ?? 1_500,
    idleMs: deps.idleMs ?? 120_000,
    epochs,
    finish,
  };

  /** Arms that ran out give their grants back, whether or not anything is running. */
  async function lapse(): Promise<void> {
    for (const origin of await deps.settings.expired()) {
      await deps.settings.disarm(origin);
      await deps.grants.revoke(origin);
    }
  }

  async function runTick(): Promise<TickReport> {
    const report: TickReport = {
      connected: false,
      driven: [],
      skipped: [],
      settled: 0,
      refused: 0,
    };
    await lapse();
    // Nothing armed and nothing in flight: there is nothing to ask the Host.
    const idle =
      (await deps.settings.armed()).size === 0 &&
      (await deps.settings.active()).size === 0;
    if (idle) return report;
    const link = await deps.connect();
    if (link === null) return report;
    report.connected = true;
    const runs = await link.host.listRuns();
    const open = new Map(runs.map((run) => [run.id, run]));
    for (const [runId, held] of await deps.settings.active()) {
      const run = open.get(runId);
      if (!run || run.closed_at !== null) await finish(runId, held.origin);
    }
    let driven = 0;
    for (const run of runs) {
      if (driven >= MAX_RUNS_PER_TICK) break;
      const reason = await skipReason(deps, run, now());
      if (reason !== null) {
        if (reason !== "closed") report.skipped.push({ runId: run.id, reason });
        continue;
      }
      driven += 1;
      await driveRun(env, run, link, report);
    }
    return report;
  }

  return {
    /** One pass over the person's runs. Overlapping calls share one pass. */
    tick(): Promise<TickReport> {
      busy ??= runTick().finally(() => {
        busy = null;
      });
      return busy;
    },
  };
}
