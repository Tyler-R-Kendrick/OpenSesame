import type { ClaimEngine } from "@opensesame/claims";
import type { Repositories } from "@opensesame/database";
import type { Logger } from "@opensesame/observability";
import type { Clock, Project, ProvisionalSession } from "@opensesame/os-domain";

export interface FakeClock {
  now: Date;
  /** Advance wall clock by ms. */
  advance(ms: number): void;
  /** Clock function for domain engines. */
  asClock(): Clock;
}

export function createFakeClock(start: Date = new Date()): FakeClock {
  let current = start.getTime();
  return {
    get now() {
      return new Date(current);
    },
    set now(value: Date) {
      current = value.getTime();
    },
    advance(ms: number) {
      current += ms;
    },
    asClock() {
      return () => new Date(current);
    },
  };
}

export interface ClaimListStore {
  listIds(): string[];
}

export interface CleanupDeps {
  /**
   * Claim, session and project state to expire.
   *
   * Optional because they live in the control plane's process. A standalone worker
   * has no access to them, and passing empty maps made it report a healthy tick
   * while expiring nothing — a worker that looks like it is enforcing TTLs and is
   * not is worse than one that says it cannot.
   */
  claims?: ClaimEngine;
  claimStore?: ClaimListStore;
  provisionalSessions?: Map<string, ProvisionalSession>;
  projects?: Map<string, Project>;
  repos: Repositories;
  clock: Clock;
  log?: Logger;
}

export interface CleanupResult {
  expiredClaims: number;
  expiredSessions: number;
  expiredProjects: number;
  reapedProjects: number;
  outboxPublished: number;
  /**
   * Whether this tick had the in-process state needed to expire anything. False
   * means the counts above are zero because nothing was inspected, not because
   * nothing had lapsed.
   */
  expiryEnforced: boolean;
}

/**
 * How long an expired project is kept for inspection before it is dropped.
 * Without a bound the map only ever grows, so a long-lived process accumulates
 * every temporary project it ever issued.
 */
export const EXPIRED_PROJECT_RETENTION_MS = 60 * 60 * 1000;

/**
 * One cleanup tick: expire claims past TTL, drop provisional sessions/projects,
 * and mark outbox events published (local sink).
 */
export async function runCleanupTick(
  deps: CleanupDeps,
): Promise<CleanupResult> {
  const now = deps.clock();
  let expiredClaims = 0;
  let expiredSessions = 0;
  let expiredProjects = 0;
  let reapedProjects = 0;
  let outboxPublished = 0;

  const claims = deps.claims;
  const claimStore = deps.claimStore;
  const provisionalSessions = deps.provisionalSessions;
  const projects = deps.projects;
  const expiryEnforced =
    claims !== undefined &&
    claimStore !== undefined &&
    provisionalSessions !== undefined &&
    projects !== undefined;

  for (const id of claimStore?.listIds() ?? []) {
    if (!claims) break;
    const session = await claims.get(id);
    if (!session) continue;
    if (
      session.state === "completed" ||
      session.state === "denied" ||
      session.state === "revoked"
    ) {
      continue;
    }
    if (session.state === "expired" || now >= session.expiresAt) {
      try {
        await claims.expire(id);
        expiredClaims += 1;
      } catch {
        // loadFresh may already persist expiry; count if store shows expired
        const after = await claims.get(id);
        if (after?.state === "expired") {
          expiredClaims += 1;
        }
      }
    }
  }

  for (const [id, session] of provisionalSessions ?? []) {
    if (session.expiresAt <= now || session.revokedAt) {
      provisionalSessions?.delete(id);
      expiredSessions += 1;
    }
  }

  for (const [id, project] of projects ?? []) {
    // An activated project expires too: checking only `provisional` left every
    // temporary project that reached `active` alive past its own TTL.
    const live = project.state === "provisional" || project.state === "active";
    if (live && project.expiresAt && project.expiresAt <= now) {
      projects?.set(id, {
        ...project,
        state: "expired",
        updatedAt: now,
      });
      expiredProjects += 1;
      continue;
    }
    if (
      (project.state === "expired" || project.state === "deleted") &&
      now.getTime() - project.updatedAt.getTime() >=
        EXPIRED_PROJECT_RETENTION_MS
    ) {
      projects?.delete(id);
      reapedProjects += 1;
    }
  }

  const pending = await deps.repos.outbox.listUnpublished(100);
  for (const event of pending) {
    if (event.availableAt <= now) {
      await deps.repos.outbox.markPublished(event.id, now);
      outboxPublished += 1;
    }
  }

  deps.log?.info(
    {
      expiredClaims,
      expiredSessions,
      expiredProjects,
      reapedProjects,
      outboxPublished,
      expiryEnforced,
    },
    "cleanup tick",
  );

  return {
    expiredClaims,
    expiredSessions,
    expiredProjects,
    reapedProjects,
    outboxPublished,
    expiryEnforced,
  };
}

export interface CleanupLoopOptions extends CleanupDeps {
  intervalMs?: number;
  signal?: AbortSignal;
}

export async function startCleanupLoop(
  options: CleanupLoopOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? 5_000;
  while (!options.signal?.aborted) {
    // A throwing tick used to end the loop, which quietly stops expiring claims,
    // sessions, and projects — credentials would then outlive their TTL for as
    // long as the process stayed up. Survive the tick, retry on the next one.
    try {
      await runCleanupTick(options);
    } catch (err) {
      options.log?.error(
        { err: err instanceof Error ? err.message : String(err) },
        "cleanup tick failed; retrying next interval",
      );
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
