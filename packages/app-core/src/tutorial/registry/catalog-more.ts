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
    id: "settings.changelog",
    description:
      "The in-app changelog of what this build shipped. It is a record, not a backup.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "changelog.read",
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
      "Exports the sealed vault body plus its key-wrapping header, for moving to another device.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "vault.export",
  },
];
