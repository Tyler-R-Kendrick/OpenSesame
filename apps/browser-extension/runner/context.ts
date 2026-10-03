/** What a step executes against, shared by the driver and the login check. */
import type { BackupStore } from "./backup";
import type { RunRef, StepPages } from "./ports";
import type { RunContext, RunnerVault } from "./vault";

/** How long the runner waits for a selector. */
export const WAIT_MS = 15_000;

/** The layout generation of the page the run is driving (ADR 0081 mask epochs). */
export interface EpochState {
  epoch: number;
  /** The layout signature at `epoch`; null when nothing has been read since it moved. */
  layout: string | null;
}

export interface DriverDeps {
  run: RunRef;
  pages: StepPages;
  vault: RunnerVault;
  /** The Host's ciphertext store, or null when there is no Host session. */
  backup: BackupStore | null;
  epoch: EpochState;
  /** How long a fresh login may take to show a verdict. */
  loginWindowMs?: number;
  /** How long a selector is waited for. */
  waitMs?: number;
}

export function ctxOf(d: DriverDeps): RunContext {
  return { runId: d.run.id, origin: d.run.origin };
}
