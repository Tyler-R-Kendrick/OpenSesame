import { listIdpRegistrations } from "@opensesame/app-core/lib/idp-registry.js";
import { ensureDefaultAccess } from "@opensesame/app-core/lib/local-access-bootstrap.js";
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
import { useVault } from "../../lib/vault/hooks.js";
import type { IdentityRailSnapshot } from "./page-tree.js";

/** Live directory, devices, and IdP registry for every Identity rail subtree. */
export function useIdentityRailSnapshot(): IdentityRailSnapshot {
  const { tomb } = useVault();
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
      // Read only — never ensureDefaultAccess here. Ensure writes notify, and
      // a notify listener that ensures again is a write→notify feedback loop
      // that also clears in-panel validation errors mid-keystroke.
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
    const seed = async () => {
      if (!tomb) {
        refresh();
        return;
      }
      try {
        await ensureDefaultAccess(tomb);
      } catch {
        // refresh still runs so the rail can show an empty/error state
      }
      if (alive) refresh();
    };
    const off = subscribeLocalIamChanges(refresh);
    void seed();
    return () => {
      alive = false;
      off();
    };
  }, [tomb]);
  return { directory, providers, devices };
}
