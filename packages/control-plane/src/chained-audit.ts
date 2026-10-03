import { createChainedAuditSink } from "@opensesame/audit";
import type { Repositories } from "@opensesame/database";
import type { ControlPlaneRepositories } from "./context.js";

/**
 * The repositories with every audit write going through the hash chain.
 *
 * Every audit write goes through the chain, so a trail cannot be quietly
 * rewritten by anything that cannot recompute every later digest. The tip is
 * read from the store on the first append: starting each process at genesis
 * would leave one disconnected run per restart, which is indistinguishable
 * from a deleted tail.
 *
 * The digest is taken over the plaintext event before it is appended, and the
 * sealed repository opens what it lists, so the chain verifies whether or not
 * the rows beneath it rest sealed (ADR 0157).
 */
export function withChainedAudit(
  baseRepos: Repositories,
): ControlPlaneRepositories {
  const chainedAudit = createChainedAuditSink(
    {
      append: (event) => baseRepos.auditEvents.append(event),
    },
    {
      tip: async () => {
        const [newest] = await baseRepos.auditEvents.list({ limit: 1 });
        return newest?.digest;
      },
      retryOnConflict: (error) => {
        return (
          "code" in error &&
          error.code === "23505" &&
          "constraint_name" in error &&
          error.constraint_name === "audit_events_previous_digest_uidx"
        );
      },
    },
  );
  return {
    ...baseRepos,
    // Class methods are on the prototype; object spread would drop them.
    transaction: (fn) => baseRepos.transaction(fn),
    auditEvents: {
      append: (event) => chainedAudit.append(event),
      list: (filter) => baseRepos.auditEvents.list(filter),
    },
  };
}
