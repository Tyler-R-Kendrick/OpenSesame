import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { useIdentitySession } from "../../bindings/identity.js";
import { useIdentityServes } from "../../lib/use-configured.js";

/**
 * The session Access › Receipts reads a trail for, or null when there is
 * nothing to read: no session, or an Identity plane that serves no audit
 * trail. A device answers as its own plane (ADR 0160) and serves the trail
 * only while a capability that keeps one is on, so a session alone is not
 * enough; "a remote URL is set" is not required either.
 */
export function useReceiptsSession(): IdentitySession | null {
  const session = useIdentitySession();
  const audit = useIdentityServes("audit");
  return audit ? session : null;
}
