/** Public node metadata hydration is separate from current vault or provider authority. */
import { DEVICE_CONNECTOR_KEYS } from "@opensesame/app-core/lib/device-connector-records.js";
import { kvHydrate } from "@opensesame/app-core/lib/kv.js";
import { initializeVaultCredentialCustody } from "@opensesame/app-core/lib/vault-credential-custody.js";
import { useEffect, useState } from "react";
import { useVault } from "../../../lib/vault/hooks.js";

export function useTailscaleBrowserNodeReady() {
  const { tomb, status, guest, awaitingSecondStep } = useVault();
  const [loaded, setLoaded] = useState<{
    tomb: string;
    failure: string;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.all([
      initializeVaultCredentialCustody(),
      kvHydrate([...DEVICE_CONNECTOR_KEYS]),
    ]).then(
      () => {
        if (current) setLoaded({ tomb, failure: "" });
      },
      () => {
        if (current)
          setLoaded({
            tomb,
            failure:
              "Could not load this browser node's saved configuration. Reload to try again.",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [tomb]);
  const failure = loaded?.tomb === tomb ? loaded.failure : "";
  return {
    ready:
      loaded?.tomb === tomb &&
      !failure &&
      status === "unlocked" &&
      !guest &&
      !awaitingSecondStep,
    failure,
  };
}
