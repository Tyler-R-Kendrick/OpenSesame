import { SETUP_TARGETS } from "./setup-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const GUIDE_TARGETS_MORE: readonly GuideTargetDescriptor[] = [
  ...SETUP_TARGETS,

  {
    id: "access.grant-ceremony",
    description:
      "The grant ceremony itself: pick what is shared, narrow the scope, decide who it is for, mint a claim code.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "delegations.offers.mint",
  },
  {
    id: "identity.claim-access",
    description:
      "Starts the ceremony that claims a grant minted for this person, by entering the claim code.",
    role: "ceremony",
    routes: ["/identity"],
    capabilityId: "delegations.claim",
  },
  {
    id: "access.relay",
    description:
      "Pending relay approval requests: a person decides whether a running agent may continue.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "relay.decide",
  },
  {
    id: "settings.backup",
    description:
      "Server-side GitHub backup of the sealed store, and the offline encrypted export that moves a vault to another device.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "backup.target.set",
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
    id: "settings.model-provider",
    description:
      "Two provider/model slug picks — voice and general inference — from Agent Harnesses connections and built-in local/browser options.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "model_plane.choose",
  },
  {
    id: "settings.secret-configs",
    description:
      "Write-only intake for secret-config values. Keys and metadata are listed; values never come back out.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "configs.set",
  },
  {
    id: "settings.sync-targets",
    description:
      "Replication targets for the sealed store, and the control that triggers a run.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "sync_targets.trigger",
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
