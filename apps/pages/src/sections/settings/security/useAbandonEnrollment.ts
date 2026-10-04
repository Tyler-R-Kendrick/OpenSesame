import { type RefObject, useEffect } from "react";
import { useVaultStore } from "../../../lib/vault/hooks.js";

/**
 * Close the sheet mid-way and nothing is kept: the pending authenticator seed
 * is dropped. The seed is gone, so the guard that stops a second begin is
 * lifted with it — under StrictMode the effects mount, clean up and mount
 * again, and the second mount must begin the enrollment the cleanup just
 * cancelled, not show a seed no store holds.
 */
export function useAbandonEnrollment(
  active: boolean,
  began: RefObject<boolean>,
) {
  const store = useVaultStore();
  useEffect(() => {
    return () => {
      if (!active) return;
      store.cancelTotpEnrollment();
      began.current = false;
    };
  }, [active, store, began]);
}
