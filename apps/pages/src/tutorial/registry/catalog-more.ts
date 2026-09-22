import { SETUP_TARGETS } from "./setup-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const GUIDE_TARGETS_MORE: readonly GuideTargetDescriptor[] = [
  ...SETUP_TARGETS,
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
      "Installs or removes a vault item type definition. Types are JSON manifests, not code paths.",
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
