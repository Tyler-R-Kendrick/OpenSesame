/**
 * The Identity tabs whose panels are the directory's, drawn from the slot
 * `enterprise.directory-provisioning` fills (`directory-panel-slot.ts`), so
 * the always-on section imports none of that code (ADR 0142).
 */

import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { useVault } from "../../lib/vault/hooks.js";
import { LocalDevicesPanel } from "./LocalDevicesPanel.js";
import { useDirectoryPanels } from "./directory-panel-slot.js";

/** Devices: this vault's browsers, then the directory's approval if it runs. */
export function DevicesTab({
  online,
  session,
}: {
  online: boolean;
  session: IdentitySession | null;
}) {
  const directory = useDirectoryPanels();
  const { tomb } = useVault();
  return (
    <>
      <LocalDevicesPanel key={tomb} tomb={tomb} />
      {directory ? (
        <directory.Devices online={online} session={session} />
      ) : null}
    </>
  );
}

export function DirectoryAgents({ online }: { online: boolean }) {
  const directory = useDirectoryPanels();
  return directory ? <directory.Agents online={online} /> : null;
}

export function DirectoryPeople({ online }: { online: boolean }) {
  const directory = useDirectoryPanels();
  return directory ? <directory.People online={online} /> : null;
}

/** Organizations: an owner's sign-in settings, under the section's list. */
export function DirectoryOrgSignIn({
  online,
  known,
}: {
  online: boolean;
  known: unknown;
}) {
  const directory = useDirectoryPanels();
  return directory ? (
    <directory.OrgSignIn online={online} known={known} />
  ) : null;
}
