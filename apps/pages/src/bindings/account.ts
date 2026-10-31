import {
  type Account,
  describeAccount,
} from "@opensesame/app-core/lib/account.js";
import { subscribeFederationSession } from "@opensesame/app-core/lib/federation-session-events.js";
import { useEffect, useMemo, useState } from "react";
import { useIdentitySession } from "./identity.js";

/**
 * The account, for a component. Re-derived when the Identity session changes
 * (sign-out clears it, a connect sets it), a verified native session changes,
 * or another tab writes the federation session. Presentation invalidation
 * carries no identity; describeAccount revalidates the current owner.
 */
export function useAccount(): Account | null {
  // The session the hook already tracks is the one described, so a component
  // and the model never disagree about whether anyone is signed in.
  const session = useIdentitySession();
  const [federationEpoch, setFederationEpoch] = useState(0);
  useEffect(() => {
    const changed = () => setFederationEpoch((epoch) => epoch + 1);
    const unsubscribe = subscribeFederationSession(changed);
    window.addEventListener("storage", changed);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", changed);
    };
  }, []);
  // Keyed on what identifies the session, not on the object: a hook that
  // hands back a fresh object per render must not make this re-derive (and
  // re-render) forever.
  const sessionKey = session
    ? `${session.principalId}\u0000${session.accessToken}`
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` is fully represented by `sessionKey`; depending on the object itself would re-derive on every render when a caller returns a fresh one.
  return useMemo(() => describeAccount(session), [sessionKey, federationEpoch]);
}
