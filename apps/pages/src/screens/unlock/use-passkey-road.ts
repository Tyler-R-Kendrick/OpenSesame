import { webauthnPrfCapabilities } from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf.js";
import { useEffect, useState } from "react";

/**
 * Whether a passkey can be offered for sealing at all. A road that cannot work
 * is absent, not tried and failed (ADR 0158): where the browser itself says it
 * has no WebAuthn PRF, no authenticator can seal a key. It cannot say whether a
 * given authenticator answers PRF — Windows Hello may not — so until it says
 * no, the road stays and the seal steps past one that cannot (`sealUnsupported`).
 */
export function usePasskeyRoad(hostOk: boolean): boolean {
  const [prf, setPrf] = useState<boolean | "unknown">("unknown");
  useEffect(() => {
    let live = true;
    webauthnPrfCapabilities().then(
      (report) => {
        if (live) setPrf(report.details.extensionPrf);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return hostOk && prf !== false;
}
