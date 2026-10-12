import { isGuestSession } from "@opensesame/app-core/lib/guest-isolation.js";
import { listIdpRegistrations } from "@opensesame/app-core/lib/idp-registry.js";
import {
  type LocalDevice,
  readLocalDevices,
} from "@opensesame/app-core/lib/local-devices.js";
import {
  type LocalIdentity,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import { useEffect, useState } from "react";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useHostedIdentityRows } from "./hosted-identity-rail.js";
import type { IdentityRailSnapshot } from "./page-tree.js";

/** Live directory, devices, and IdP registry for every Identity rail subtree. */
export function useIdentityRailSnapshot(): IdentityRailSnapshot {
  const { tomb } = useVault();
  const configured = useIdentityConfigured();
  const hosted = useHostedIdentityRows();
  const [directory, setDirectory] = useState<LocalIdentity[]>([]);
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [providers, setProviders] = useState(() => listIdpRegistrations());
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      setProviders(listIdpRegistrations());
      if (!tomb) {
        setDirectory([]);
        setDevices([]);
        return;
      }
      // Navigation only reads sealed state. Bootstrapping on another tree's
      // mount would change the directory revision and invalidate active sign-ins.
      void Promise.all([readLocalDirectory(tomb), readLocalDevices(tomb)])
        .then(([next, deviceRows]) => {
          if (!alive) return;
          setDirectory(next.entries);
          setDevices(deviceRows);
        })
        .catch(() => {
          if (alive) {
            setDirectory([]);
            setDevices([]);
          }
        });
    };
    const off = subscribeLocalIamChanges(refresh);
    refresh();
    return () => {
      alive = false;
      off();
    };
  }, [tomb]);
  return {
    directory,
    providers,
    devices,
    hosted: configured && !isGuestSession() ? hosted : undefined,
  };
}
