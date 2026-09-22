import { useCallback, useEffect, useState } from "react";
import {
  type IdentitySession,
  currentSession,
  ensureIdentitySession,
  orphanSessionActive,
  subscribeIdentitySession,
} from "../lib/identity.js";

/** Live orphan-cookie state, so a failed revoke puts the warning back. */
function useOrphanSessionDefault(): boolean {
  const [value, setValue] = useState(orphanSessionActive);
  useEffect(
    () => subscribeIdentitySession(() => setValue(orphanSessionActive())),
    [],
  );
  return value;
}

function useIdentitySessionDefault(): IdentitySession | null {
  const [value, setValue] = useState(currentSession);
  useEffect(
    () => subscribeIdentitySession(() => setValue(currentSession())),
    [],
  );
  return value;
}

/** Connect-on-demand helper shared by every section that needs a principal. */
function useConnectDefault() {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await ensureIdentitySession();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not reach OpenSesame Identity.",
      );
    } finally {
      setConnecting(false);
    }
  }, []);
  return { connecting, error, connect };
}

/** Test seam for the identity hooks; the session logic lives in lib/identity. */
export const identityHookSeams = {
  useIdentitySession: useIdentitySessionDefault,
  useConnect: useConnectDefault,
  useOrphanSession: useOrphanSessionDefault,
};

export function useIdentitySession(): IdentitySession | null {
  return identityHookSeams.useIdentitySession();
}

export function useConnect() {
  return identityHookSeams.useConnect();
}

export function useOrphanSession(): boolean {
  return identityHookSeams.useOrphanSession();
}
