import {
  type Account,
  describeAccount,
} from "@opensesame/app-core/lib/account.js";
import { useEffect, useMemo, useState } from "react";
import { useIdentitySession } from "./identity.js";

/**
 * The account, for a component. Re-derived when the Identity session changes
 * (sign-out clears it, a connect sets it) and when another tab writes the
 * federation session — the two moments the answer can move without a
 * navigation.
 */
export function useAccount(): Account | null {
  // The session the hook already tracks is the one described, so a component
  // and the model never disagree about whether anyone is signed in.
  const session = useIdentitySession();
  // Another tab signing in or out rewrites the federation session; that is
  // the one move the answer can make without this tab navigating.
  const [storageEpoch, setStorageEpoch] = useState(0);
  useEffect(() => {
    const onStorage = () => setStorageEpoch((epoch) => epoch + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // Keyed on what identifies the session, not on the object: a hook that
  // hands back a fresh object per render must not make this re-derive (and
  // re-render) forever.
  const sessionKey = session
    ? `${session.principalId}\u0000${session.accessToken}`
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` is fully represented by `sessionKey`; depending on the object itself would re-derive on every render when a caller returns a fresh one.
  return useMemo(() => describeAccount(session), [sessionKey, storageEpoch]);
}
