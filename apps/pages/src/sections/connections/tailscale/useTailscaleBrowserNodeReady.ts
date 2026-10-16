/** Public node metadata hydration is separate from current vault or provider authority. */
import { useEffect, useState } from "react";
import { useVault } from "../../../lib/vault/hooks.js";
import { hydrateTailscaleDeviceRows } from "./tailscale-hydration.js";

export function useTailscaleBrowserNodeReady() {
  const { tomb, status, guest, awaitingSecondStep } = useVault();
  const [loaded, setLoaded] = useState<{
    tomb: string;
    failure: string;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void hydrateTailscaleDeviceRows(tomb).then(
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
