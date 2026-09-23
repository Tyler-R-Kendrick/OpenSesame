import {
  type FederatedProviderSummary,
  listFederatedProviders,
} from "@opensesame/app-core/lib/providers.js";
import { useEffect, useState } from "react";

/**
 * Whatever this deployment brokers (D7), fetched once for both the front
 * door and the unlock form. An empty catalog — no Identity API, an
 * unreachable one, a deployment older than the endpoint — is not an error
 * state: SignInPanel falls back to the single default upstream.
 */
export function useFederatedProviders(): FederatedProviderSummary[] {
  const [providers, setProviders] = useState<FederatedProviderSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listFederatedProviders()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => {
        /* the empty catalog stands */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return providers;
}
