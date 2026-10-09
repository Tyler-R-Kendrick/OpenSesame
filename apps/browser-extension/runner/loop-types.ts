/** The runner loop's ports, options and report. */
import type {
  AgentRunView,
  ClaimedRunnerStep,
  RunnerStepOutcome,
  SettledRunnerStep,
} from "@opensesame/api-client";
import type { BackupStore } from "./backup";
import type { Grants, PagesFactory } from "./ports";
import type { RunnerSettings } from "./settings";
import type { RunnerVault } from "./vault";

export interface HostPort {
  listRuns(): Promise<AgentRunView[]>;
  getRun(id: string): Promise<AgentRunView>;
  claim(runId: string): Promise<ClaimedRunnerStep | null>;
  settle(
    runId: string,
    seq: number,
    outcome: RunnerStepOutcome,
  ): Promise<SettledRunnerStep>;
}

export interface Connection {
  host: HostPort;
  backup: BackupStore;
}

export interface RunnerDeps {
  settings: RunnerSettings;
  vault: RunnerVault;
  grants: Grants;
  pagesFor: PagesFactory;
  /** Close the tab a finished run was driven in. */
  closePage: (tabId: number | null) => Promise<void>;
  /** The Host session, or null when the person has not given one. */
  connect: () => Promise<Connection | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between polls of an idle run. */
  pollMs?: number;
  /** How long an idle run is waited on before the tick ends. */
  idleMs?: number;
  loginWindowMs?: number;
  waitMs?: number;
}

/** Why a run was not claimed. Never carries anything the Host or a page said. */
export type Skip =
  | "closed"
  | "expired"
  | "human_holds_page"
  | "not_driving"
  | "origin_refused"
  | "not_armed"
  | "no_grant"
  | "no_credential"
  | "no_recovery_key"
  | "no_private_context"
  | "no_page";

export interface TickReport {
  /** The Host was reached under the person's session. */
  connected: boolean;
  driven: string[];
  skipped: { runId: string; reason: Skip }[];
  /** Steps settled, by run. */
  settled: number;
  /** A claimed step the runner would not execute (a tag it does not know). */
  refused: number;
}
