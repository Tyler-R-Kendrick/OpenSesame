import type { Clock, ProvisionalSession, Project } from "@opensesame/os-domain";
import type { ClaimEngine } from "@opensesame/claims";
import type { Repositories } from "@opensesame/database";
import type { Logger } from "@opensesame/observability";

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
  claims: ClaimEngine;
  claimStore: ClaimListStore;
  repos: Repositories;
  provisionalSessions: Map<string, ProvisionalSession>;
  projects: Map<string, Project>;
  clock: Clock;
  log?: Logger;
}

export interface CleanupResult {
  expiredClaims: number;
  expiredSessions: number;
  expiredProjects: number;
  outboxPublished: number;
}

/**
 * One cleanup tick: expire claims past TTL, drop provisional sessions/projects,
 * and mark outbox events published (local sink).
 */
export async function runCleanupTick(deps: CleanupDeps): Promise<CleanupResult> {
  const now = deps.clock();
  let expiredClaims = 0;
  let expiredSessions = 0;
  let expiredProjects = 0;
  let outboxPublished = 0;

  for (const id of deps.claimStore.listIds()) {
    const session = await deps.claims.get(id);
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
        await deps.claims.expire(id);
        expiredClaims += 1;
      } catch {
        // loadFresh may already persist expiry; count if store shows expired
        const after = await deps.claims.get(id);
        if (after?.state === "expired") {
          expiredClaims += 1;
        }
      }
    }
  }

  for (const [id, session] of deps.provisionalSessions) {
    if (session.expiresAt <= now || session.revokedAt) {
      deps.provisionalSessions.delete(id);
      expiredSessions += 1;
    }
  }

  for (const [id, project] of deps.projects) {
    if (
      project.expiresAt &&
      project.expiresAt <= now &&
      project.state === "provisional"
    ) {
      deps.projects.set(id, {
        ...project,
        state: "expired",
        updatedAt: now,
      });
      expiredProjects += 1;
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
    { expiredClaims, expiredSessions, expiredProjects, outboxPublished },
    "cleanup tick",
  );

  return { expiredClaims, expiredSessions, expiredProjects, outboxPublished };
}

export interface CleanupLoopOptions extends CleanupDeps {
  intervalMs?: number;
  signal?: AbortSignal;
}

export async function startCleanupLoop(options: CleanupLoopOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 5_000;
  while (!options.signal?.aborted) {
    await runCleanupTick(options);
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
