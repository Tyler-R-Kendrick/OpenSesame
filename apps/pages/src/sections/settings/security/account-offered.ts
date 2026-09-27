import { accountFactorsOffered } from "@opensesame/app-core/lib/account-factors.js";
import { subscribeIdentitySession } from "@opensesame/app-core/lib/identity.js";
import { subscribeSettings } from "@opensesame/app-core/lib/settings.js";
import { useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
  const offIdentity = subscribeIdentitySession(listener);
  const offSettings = subscribeSettings(listener);
  return () => {
    offIdentity();
    offSettings();
  };
}

/**
 * Whether Security › Your account draws: an Identity API is configured and a
 * session is held, live. The panel and the rail read the same answer.
 */
export function useAccountFactorsOffered(): boolean {
  return useSyncExternalStore(subscribe, () => accountFactorsOffered());
}
