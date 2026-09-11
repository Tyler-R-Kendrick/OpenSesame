import { useEffect, useState } from "react";
import { listIdpRegistrations } from "../../lib/idp-registry.js";
import {
  type LocalIdentity,
  currentOwnerPersonName,
  ensureOwnerPerson,
} from "../../lib/local-directory.js";
import { type LocalDevice, ensureThisDevice } from "../../lib/local-devices.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import type { IdentityRailSnapshot } from "./page-tree.js";

/** Live directory, devices, and IdP registry for every Identity rail subtree. */
export function useIdentityRailSnapshot(): IdentityRailSnapshot {
  const tomb = useVaultStore().activeTomb?.() ?? "";
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
      void ensureOwnerPerson(tomb, currentOwnerPersonName())
        .then((next) => {
          if (alive) setDirectory(next.entries);
        })
        .catch(() => {
          if (alive) setDirectory([]);
        });
      void ensureThisDevice(tomb)
        .then((next) => {
          if (alive) setDevices(next);
        })
        .catch(() => {
          if (alive) setDevices([]);
        });
    };
    const off = subscribeLocalIamChanges(refresh);
    refresh();
    return () => {
      alive = false;
      off();
    };
  }, [tomb]);
  return { directory, providers, devices };
}
