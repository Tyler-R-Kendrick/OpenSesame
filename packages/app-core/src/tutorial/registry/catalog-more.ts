import { SETUP_TARGETS } from "./setup-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const GUIDE_TARGETS_MORE: readonly GuideTargetDescriptor[] = [
  ...SETUP_TARGETS,
  {
    id: "settings.transport",
    description:
      "The Transport panel under Security: the target this device asks about, its policy and identity by reference, and one mark each for the desired policy, the credential, the runtime, what a peer observed and whether anything is enforced. Optional \u2014 with no endpoint set it asks nothing.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "transport.status.view",
  },
  {
    id: "settings.tailnet-sync",
    description:
      "The Tailnet sync panel under Vaults, while Networking is on: pair this vault with a drive on the tailnet (the pair key opens a sheet where the code goes), see whether it is in step, sync now, or stop. The drive holds only the sealed vault.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "vault.drive.sync",
  },
  {
    id: "settings.item-types",
    description:
      "Installs or removes a vault item type definition, from a git-repository marketplace or pasted source. Types are JSON manifests, not code paths.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "vault.item_types.install",
  },
  {
    id: "settings.install",
    description:
      "Installs this app on the device as a PWA, so it is available without a browser chrome.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "app.install",
  },
  {
    id: "vault.export",
    description:
      "Opens the export sheet in the vault's path strip: one encrypted backup file of the sealed vault body plus its key-wrapping header, opened again with the master password, for moving to another device.",
    role: "ceremony",
    routes: ["/vault"],
    capabilityId: "vault.export",
  },
];
