import {
  type LocalIdentity,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  actingOwner,
  ownershipRecipients,
} from "@opensesame/app-core/lib/vault-ownership.js";
import { useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";

/**
 * Who the open vault's owner may hand it to. Empty unless the person acting
 * owns the vault, so the Danger zone draws no key that could only fail. It
 * only reads: the directory is never bootstrapped by looking at Settings.
 */
export function useVaultOwnership(): readonly LocalIdentity[] {
  const { tomb } = useVault();
  const [recipients, setRecipients] = useState<readonly LocalIdentity[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (!tomb) {
        setRecipients([]);
        return;
      }
      void readLocalDirectory(tomb)
        .then(async (directory) => {
          const owner = await actingOwner(tomb, directory);
          if (alive) {
            setRecipients(
              owner ? ownershipRecipients(directory, owner.id) : [],
            );
          }
        })
        .catch(() => {
          if (alive) setRecipients([]);
        });
    };
    const off = subscribeLocalIamChanges(refresh);
    refresh();
    return () => {
      alive = false;
      off();
    };
  }, [tomb]);
  return recipients;
}
