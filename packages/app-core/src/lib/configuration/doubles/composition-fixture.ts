/**
 * Deterministic inventory for the capability surfaces' tests.
 *
 * A small catalog with every shape the UI has to draw — a core capability, a
 * hard dependency, an alternatives slot, a permission, egress that starts on
 * its own, a worker constraint — and the five purpose presets over it. Test
 * support, never shipped: the seam (`lib/configuration/capabilities-ports`)
 * is mocked with this and `composition-double.ts`.
 */

import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilityId,
  InstanceCapabilityPolicy,
} from "@opensesame/capability-composition";
import type { CapabilityPreset } from "../capabilities-ports.js";

type Draft = Partial<CapabilityDescriptor> &
  Pick<CapabilityDescriptor, "id" | "title">;

function descriptor(draft: Draft): CapabilityDescriptor {
  return {
    descriptorVersion: 1,
    tier: "optional",
    summary: `${draft.title}.`,
    dependencies: [],
    alternatives: [],
    operationIds: [`${draft.id}.use`],
    moduleIds: [`${draft.id}/runtime`],
    environments: ["document"],
    egress: [],
    browserPermissions: [],
    keyAccess: "none",
    requiresService: false,
    offlineLimits: "",
    workerGraphConstraint: null,
    requiresDocumentReload: false,
    itemKinds: [],
    exposureDigest: `sha256:fixture-${draft.id}`,
    ...draft,
  };
}

export const FIXTURE_CATALOG: CapabilityCatalog = {
  catalogVersion: 1,
  capabilities: [
    descriptor({ id: "vault.passwords", title: "Passwords", tier: "core" }),
    descriptor({
      id: "vault.local-unlock",
      title: "Local unlock",
      tier: "core",
    }),
    descriptor({
      id: "backup.local-encrypted",
      title: "Encrypted file backup",
      tier: "core",
      summary: "Export and import an encrypted copy of the vault as a file.",
    }),
    descriptor({
      id: "identity.brokered-signin",
      title: "Brokered sign-in",
      tier: "core",
    }),
    descriptor({ id: "settings.core", title: "Settings", tier: "core" }),
    descriptor({
      id: "vault.passkey-records",
      title: "Passkey records",
      summary: "Keep passkeys as vault items.",
      itemKinds: ["passkey"],
    }),
    descriptor({
      id: "connectors.external",
      title: "External connectors",
      summary: "List connectors from a directory you name.",
      egress: [
        {
          class: "external-service",
          purpose: "the connector directory",
          automatic: false,
        },
      ],
      offlineLimits: "The directory is not listed offline.",
    }),
    descriptor({
      id: "backup.git-remote",
      title: "Git remote backup",
      summary: "Push encrypted snapshots to a git remote.",
      dependencies: ["connectors.external"],
      egress: [
        {
          class: "external-service",
          purpose: "the git remote",
          automatic: true,
        },
      ],
      requiresService: true,
    }),
    descriptor({
      id: "sharing.drops",
      title: "Shared drops",
      summary: "Hand an item to another person through the Identity API.",
      requiresService: true,
      egress: [
        {
          class: "external-service",
          purpose: "the Identity API",
          automatic: false,
        },
      ],
    }),
    descriptor({
      id: "sharing.household",
      title: "Household sharing",
      summary: "Share folders with the people in your household.",
      alternatives: [{ slot: "transport", oneOf: ["sharing.drops"] }],
    }),
    descriptor({
      id: "notifications.web-push",
      title: "Push notifications",
      summary: "Be told about approvals while the app is closed.",
      browserPermissions: ["notifications"],
      environments: ["document", "service-worker"],
      moduleIds: [
        "notifications.web-push/runtime",
        "notifications.web-push/worker",
      ],
      workerGraphConstraint: "push",
      requiresDocumentReload: true,
      egress: [
        {
          class: "external-service",
          purpose: "the push service",
          automatic: true,
        },
      ],
    }),
    descriptor({
      id: "agents.webmcp",
      title: "Agent tools (WebMCP)",
      summary: "Expose fenced tools to an agent in this browser.",
    }),
    descriptor({
      id: "support.guided-help",
      title: "Guided help",
      summary: "In-product tours that point, never act.",
    }),
    descriptor({
      id: "telemetry.external",
      title: "External telemetry",
      summary: "Send anonymous usage counts to an operator's collector.",
      egress: [
        {
          class: "external-service",
          purpose: "the collector",
          automatic: true,
        },
      ],
    }),
    descriptor({
      id: "identity.federation",
      title: "Federated sign-in",
      summary: "Sign in through an operator's identity providers.",
      requiresService: true,
    }),
  ],
};

export const FIXTURE_IDS: readonly CapabilityId[] =
  FIXTURE_CATALOG.capabilities.map((entry) => entry.id);

const OPTIONAL_IDS = FIXTURE_CATALOG.capabilities
  .filter((entry) => entry.tier === "optional")
  .map((entry) => entry.id);

const ALLOW = { externalServices: "allow", allowedServiceOrigins: [] } as const;

export const FIXTURE_PRESETS: readonly CapabilityPreset[] = [
  {
    id: "personal",
    version: 1,
    title: "Personal",
    summary: "One person, this device, nothing leaves it unless you say so.",
    required: [],
    optional: [
      "vault.passkey-records",
      "support.guided-help",
      "notifications.web-push",
    ],
    defaultSelected: ["vault.passkey-records"],
    network: { externalServices: "deny", allowedServiceOrigins: [] },
  },
  {
    id: "family",
    version: 1,
    title: "Family",
    summary: "A household that shares folders.",
    required: ["sharing.household"],
    optional: ["vault.passkey-records", "sharing.drops", "support.guided-help"],
    defaultSelected: ["sharing.drops"],
    network: ALLOW,
  },
  {
    id: "homelab",
    version: 1,
    title: "Homelab",
    summary: "Your own services, your own remote.",
    required: [],
    optional: [
      "connectors.external",
      "backup.git-remote",
      "agents.webmcp",
      "vault.passkey-records",
    ],
    defaultSelected: ["connectors.external", "backup.git-remote"],
    network: ALLOW,
  },
  {
    id: "organization",
    version: 1,
    title: "Organization",
    summary: "An operator signs people in and decides what runs.",
    required: ["identity.federation"],
    optional: ["connectors.external", "sharing.drops", "telemetry.external"],
    defaultSelected: [],
    network: ALLOW,
  },
  {
    id: "custom",
    version: 1,
    title: "Custom",
    summary: "Start from nothing and pick each capability.",
    required: [],
    optional: OPTIONAL_IDS,
    defaultSelected: [],
    network: ALLOW,
  },
];

export function fixturePresetToInstancePolicy(
  preset: CapabilityPreset,
  instanceId: string,
  revision: string,
): InstanceCapabilityPolicy {
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId,
    revision,
    presetProvenance: { id: preset.id, version: preset.version },
    capabilities: {
      default: "deny",
      required: [...preset.required],
      optional: [...preset.optional],
      prohibited: [],
    },
    network: preset.network,
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  };
}

/** A managed instance that requires household sharing and forbids connectors. */
export const FIXTURE_MANAGED_POLICY: InstanceCapabilityPolicy = {
  schemaVersion: 1,
  kind: "InstanceCapabilityPolicy",
  instanceId: "acme",
  revision: "7",
  presetProvenance: { id: "family", version: 1 },
  capabilities: {
    default: "deny",
    required: ["sharing.household"],
    optional: ["sharing.drops", "backup.git-remote", "vault.passkey-records"],
    prohibited: ["connectors.external", "telemetry.external"],
  },
  network: ALLOW,
  updates: {
    unknownCapabilities: "deny",
    expandedExposure: "require-approval",
  },
};
