/**
 * The Identity tabs whose panels are the directory's, drawn from the slot
 * `enterprise.directory-provisioning` fills (`directory-panel-slot.ts`), so
 * the always-on section imports none of that code (ADR 0142).
 */

import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useVault } from "../../lib/vault/hooks.js";
import { DevicesWorkspace } from "./DevicesWorkspace.js";
import { useDirectoryPanels } from "./directory-panel-slot.js";
import { useTailnetDevices } from "./tailnet-devices-slot.js";

/**
 * Devices: the tailnet's machines when device management is on (ADR 0169),
 * this vault's browsers, then the directory's approval if it runs.
 */
export function DevicesTab({
  online,
  session,
}: {
  online: boolean;
  session: IdentitySession | null;
}) {
  const directory = useDirectoryPanels();
  const configured = useIdentityConfigured();
  const Tailnet = useTailnetDevices();
  const { tomb } = useVault();
  return (
    <DevicesWorkspace
      key={tomb}
      tomb={tomb}
      tailnet={Tailnet ? <Tailnet /> : undefined}
      approval={
        configured && directory ? (
          <directory.Devices online={online} session={session} />
        ) : undefined
      }
    />
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
  selectedOrg,
}: {
  online: boolean;
  known: unknown;
  selectedOrg?: string;
}) {
  const directory = useDirectoryPanels();
  return directory ? (
    <directory.OrgSignIn
      online={online}
      known={known}
      selectedOrg={selectedOrg}
    />
  ) : null;
}
