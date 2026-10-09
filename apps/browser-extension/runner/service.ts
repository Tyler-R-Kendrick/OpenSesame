/**
 * What the background and the options page ask of the runner: arm an origin,
 * give it back, say what is ready, and take one pass over the person's runs.
 * None of it returns a value the runner holds.
 */
import { RunnerApiError } from "@opensesame/api-client";
import { type Connection, type TickReport, createRunner } from "./loop";
import { drivable } from "./origin";
import type { Grants, PagesFactory } from "./ports";
import type { RunnerSettings } from "./settings";
import type { CandidateSummary, RunnerVault } from "./vault";

/** What the last pass did, in words that name no run's content. */
export interface PassSummary {
  at: number;
  connected: boolean;
  driven: number;
  settled: number;
  refused: number;
  /** Why runs were not claimed, once each (`not_armed`, `no_grant` …). */
  skipped: string[];
  /** Why the pass ended early: the Host's status and code, or `unreachable`. */
  error: string | null;
}

export interface RunnerStatus {
  /** A Host session is held. */
  session: boolean;
  /** A private window can be opened, to prove a login in. */
  privateAllowed: boolean;
  /** A recovery recipient is pinned, so a candidate can be backed up. */
  recovery: boolean;
  /** Origins a credential is held for. Names only. */
  credentials: string[];
  armed: { origin: string; expiresAt: number; granted: boolean }[];
  /** Runs being driven. */
  active: string[];
  candidates: CandidateSummary[];
  /** The last pass this worker made, or null if it has made none. */
  lastPass: PassSummary | null;
}

export type ArmResult = "armed" | "origin_refused" | "no_grant";

export interface ServiceDeps {
  settings: RunnerSettings;
  vault: RunnerVault;
  grants: Grants;
  pagesFor: PagesFactory;
  closePage: (tabId: number | null) => Promise<void>;
  connect: () => Promise<Connection | null>;
}

function summarize(
  report: TickReport | null,
  error: string | null,
  at: number,
): PassSummary {
  return {
    at,
    connected: report?.connected ?? false,
    driven: report?.driven.length ?? 0,
    settled: report?.settled ?? 0,
    refused: report?.refused ?? 0,
    skipped: [...new Set((report?.skipped ?? []).map((s) => s.reason))],
    error,
  };
}

function failure(error: Error): string {
  return error instanceof RunnerApiError
    ? `${error.status}:${error.code || "refused"}`
    : "unreachable";
}

export function createRunnerService(deps: ServiceDeps) {
  const runner = createRunner(deps);
  let last: PassSummary | null = null;
  return {
    /** One pass. What it did, or why it could not, is kept for `status`. */
    async tick(): Promise<TickReport> {
      try {
        const report = await runner.tick();
        last = summarize(report, null, Date.now());
        return report;
      } catch (error) {
        last = summarize(
          null,
          error instanceof Error ? failure(error) : "unreachable",
          Date.now(),
        );
        throw error;
      }
    },

    /**
     * Arm one origin for a bounded time. The browser's grant must already be
     * held — the options page asks for it on the person's own click, and a
     * message cannot make the browser grant anything.
     */
    async arm(origin: string): Promise<ArmResult> {
      if (!drivable(origin)) return "origin_refused";
      if (!(await deps.grants.has(origin))) return "no_grant";
      await deps.settings.arm(origin);
      return "armed";
    },

    async disarm(origin: string): Promise<void> {
      await deps.settings.disarm(origin);
      await deps.grants.revoke(origin);
    },

    async status(): Promise<RunnerStatus> {
      const armed = await deps.settings.armed();
      return {
        session: (await deps.settings.token()) !== null,
        privateAllowed: await deps.grants.privateAllowed(),
        recovery: (await deps.vault.recipient()) !== null,
        credentials: await deps.vault.origins(),
        armed: await Promise.all(
          [...armed].map(async ([origin, row]) => ({
            origin,
            expiresAt: row.expiresAt,
            granted: await deps.grants.has(origin),
          })),
        ),
        active: [...(await deps.settings.active()).keys()],
        candidates: await deps.vault.candidates(),
        lastPass: last,
      };
    },
  };
}

export type RunnerService = ReturnType<typeof createRunnerService>;
