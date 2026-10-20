import { SETUP_TARGETS } from "./setup-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const GUIDE_TARGETS_MORE: readonly GuideTargetDescriptor[] = [
  ...SETUP_TARGETS,
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
      "Switches built-in vault item types on or off, one switch per type: switching one on downloads and installs it, and nothing of it is in the app until then. A search field narrows the list; a type the vault already holds items of stays on and shows its count. Types a person wrote sit beneath, and a key opens the marketplaces, git repositories read for more types. Types are JSON manifests, not code paths.",
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
      "Opens the export sheet in the vault's path strip: one encrypted backup file of the sealed vault body plus its key-wrapping header, opened again with the unlock the vault already has, for moving to another device.",
    role: "ceremony",
    routes: ["/vault"],
    capabilityId: "vault.export",
  },
];
