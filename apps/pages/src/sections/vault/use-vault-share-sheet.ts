import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { createLocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";

export function useVaultShareSheet(onClose: () => void) {
  const { tomb } = useVault();
  const [identities, setIdentities] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [canGrant, setCanGrant] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [directory, { canAccess, resolveCurrentAccessRole }] =
          await Promise.all([
            readLocalDirectory(tomb),
            import("@opensesame/app-core/lib/local-rbac.js"),
          ]);
        if (!live) return;
        const actor = await resolveCurrentAccessRole(tomb);
        setCanGrant(canAccess(actor, "manage_grants"));
        setIdentities(
          directory.entries
            .filter(
              (entry) =>
                (entry.kind === "person" || entry.kind === "agent") &&
                entry.enabled,
            )
            .map((entry) => ({ id: entry.id, name: entry.name })),
        );
      } catch {
        if (!live) return;
        setCanGrant(false);
        setIdentities([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [tomb]);

  async function save(input: Parameters<typeof createLocalShare>[1]) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await createLocalShare(tomb, input);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not grant access.",
      );
    } finally {
      setBusy(false);
    }
  }

  return { identities, canGrant, busy, error, save };
}
