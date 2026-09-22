/**
 * Deterministic fixtures shared by every package's tests.
 *
 * Twelve capabilities: two core, a three-deep dependency chain, an
 * alternatives slot with a local and a remote option (the remote one polls a
 * service on its own), a worker-constrained capability, one that only runs
 * in a shared worker, and one with automatic external telemetry. Nothing
 * here is wired to a real feature; ids mirror the product catalog so example
 * documents validate against both.
 */
import { buildCatalog } from "./catalog.js";
import type { ResolveInput } from "./resolve-input.js";
import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  DistributionContract,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  RuntimeFacts,
} from "./types.js";

type Declared = Omit<CapabilityDescriptor, "exposureDigest">;

function describe(
  id: string,
  title: string,
  summary: string,
  overrides: Partial<Declared> = {},
): Declared {
  return {
    id,
    descriptorVersion: 1,
    tier: "optional",
    title,
    summary,
    dependencies: [],
    alternatives: [],
    operationIds: [],
    moduleIds: [`${id}/runtime`],
    environments: ["document"],
    egress: [],
    browserPermissions: [],
    keyAccess: "none",
    requiresService: false,
    offlineLimits: "",
    workerGraphConstraint: null,
    requiresDocumentReload: false,
    itemKinds: [],
    ...overrides,
  };
}

const IDENTITY_API = {
  class: "external-service",
  purpose: "the configured Identity API",
  automatic: false,
} as const;

export const FIXTURE_CATALOG: CapabilityCatalog = buildCatalog(
  [
    describe(
      "vault.passwords",
      "Passwords",
      "Items, the editor, login and note kinds, health.",
      {
        tier: "core",
        operationIds: ["pages.items.list", "pages.items.edit"],
        itemKinds: ["login", "note"],
        keyAccess: "item-plaintext",
      },
    ),
    describe(
      "settings.core",
      "Settings",
      "General, Security, Vaults, Danger, Capabilities.",
      {
        tier: "core",
        operationIds: ["pages.settings.prefs.edit"],
      },
    ),
    describe(
      "vault.passkey-records",
      "Passkey records",
      "Store and use passkeys as vault items.",
      {
        operationIds: ["pages.items.passkey.create"],
        itemKinds: ["passkey"],
        browserPermissions: ["webauthn"],
        keyAccess: "item-plaintext",
      },
    ),
    describe(
      "identity.federation",
      "Federated sign-in",
      "Sign in through the configured Identity API.",
      {
        operationIds: ["pages.identity.signin"],
        egress: [IDENTITY_API],
        requiresService: true,
        offlineLimits:
          "Sign-in needs the network; a held session keeps working.",
      },
    ),
    describe(
      "access.authority",
      "Access authority",
      "Grants, principals and shares.",
      {
        dependencies: ["identity.federation"],
        operationIds: ["pages.access.grants.list"],
        requiresService: true,
      },
    ),
    describe(
      "connectors.external",
      "External connectors",
      "Connectors by reference from a directory.",
      {
        dependencies: ["access.authority"],
        operationIds: ["pages.connectors.list"],
        egress: [
          {
            class: "external-service",
            purpose: "the connector directory",
            automatic: false,
          },
        ],
        requiresService: true,
      },
    ),
    describe(
      "sharing.local-transport",
      "Local sharing transport",
      "Share with nearby devices.",
      {
        environments: ["document", "dedicated-worker"],
        egress: [
          {
            class: "peer-or-local-network",
            purpose: "nearby devices",
            automatic: false,
          },
        ],
      },
    ),
    describe(
      "sharing.drops",
      "Drop sharing",
      "Share through Identity API drops.",
      {
        dependencies: ["identity.federation"],
        egress: [
          {
            class: "external-service",
            purpose: "drop polling against the Identity API",
            automatic: true,
          },
        ],
        requiresService: true,
      },
    ),
    describe(
      "sharing.household",
      "Household sharing",
      "Share items with a household over one transport.",
      {
        alternatives: [
          {
            slot: "transport",
            oneOf: ["sharing.local-transport", "sharing.drops"],
          },
        ],
        operationIds: ["pages.sharing.share"],
      },
    ),
    describe(
      "notifications.web-push",
      "Web push",
      "Approval prompts delivered as push notifications.",
      {
        environments: ["document", "service-worker"],
        moduleIds: [
          "notifications.web-push/runtime",
          "notifications.web-push/worker",
        ],
        browserPermissions: ["notifications"],
        workerGraphConstraint: "push",
        requiresDocumentReload: true,
      },
    ),
    describe(
      "support.local-ai",
      "On-device support model",
      "Guided help computed on this device.",
      {
        environments: ["shared-worker"],
        offlineLimits: "Runs entirely on device.",
      },
    ),
    describe(
      "telemetry.external",
      "External telemetry",
      "Usage metrics sent to a collector.",
      {
        egress: [
          {
            class: "external-service",
            purpose: "the telemetry collector",
            automatic: true,
          },
        ],
      },
    ),
  ],
  1,
);

export const FIXTURE_DISTRIBUTION: DistributionContract = {
  distributionId: "fixture-distribution-1",
  mode: "selective",
  capabilityIds: FIXTURE_CATALOG.capabilities.map((d) => d.id),
  moduleIds: FIXTURE_CATALOG.capabilities.flatMap((d) => d.moduleIds),
  workerVariants: [
    { id: "core-only", scriptPath: "sw.js", satisfies: [] },
    { id: "push", scriptPath: "sw-push.js", satisfies: ["push"] },
  ],
  basePath: "/OpenSesame/",
};

const UPDATES = {
  unknownCapabilities: "deny",
  expandedExposure: "require-approval",
} as const;

export const FIXTURE_POLICIES: {
  personalLocal: null;
  family: InstanceCapabilityPolicy;
  managedProhibited: InstanceCapabilityPolicy;
} = {
  personalLocal: null,
  family: {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId: "fixture-family",
    revision: "family-r1",
    presetProvenance: { id: "family", version: 1 },
    capabilities: {
      default: "deny",
      required: ["identity.federation"],
      optional: [
        "vault.passkey-records",
        "access.authority",
        "connectors.external",
        "sharing.local-transport",
        "sharing.drops",
        "sharing.household",
        "notifications.web-push",
        "support.local-ai",
      ],
      prohibited: ["telemetry.external"],
    },
    network: {
      externalServices: "allow",
      allowedServiceOrigins: ["https://id.example.test"],
    },
    updates: UPDATES,
  },
  managedProhibited: {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId: "fixture-managed",
    revision: "managed-r7",
    presetProvenance: { id: "managed", version: 3 },
    capabilities: {
      default: "deny",
      required: ["identity.federation"],
      optional: [
        "access.authority",
        "connectors.external",
        "vault.passkey-records",
      ],
      prohibited: [
        "sharing.drops",
        "sharing.household",
        "sharing.local-transport",
        "telemetry.external",
        "notifications.web-push",
        "support.local-ai",
      ],
    },
    network: { externalServices: "deny", allowedServiceOrigins: [] },
    updates: UPDATES,
  },
};

export const FIXTURE_FACTS: RuntimeFacts = {
  environments: ["document", "dedicated-worker", "service-worker"],
  serviceWorkerAvailable: true,
  activeWorkerVariant: "core-only",
  cleanRealm: true,
  evaluatedModuleIds: [],
  now: "2026-09-22T00:00:00.000Z",
};

export const FIXTURE_INSTALLATION_ID = "fixture-installation";

/** A joined `family` installation with one optional root selected. */
export const FIXTURE_INSTALLATION: InstallationCapabilitySelection = {
  schemaVersion: 1,
  kind: "InstallationCapabilitySelection",
  instanceId: "fixture-family",
  installationId: FIXTURE_INSTALLATION_ID,
  basePolicyRevision: "family-r1",
  revision: "selection-1",
  acceptedRequired: ["identity.federation"],
  selectedOptional: ["connectors.external"],
  chosenAlternatives: {},
  delivery: { prefetch: "none", offlineCache: "shell-only" },
};

/** A personal-local resolve input; override any field. */
export function fixtureResolveInput(
  overrides: Partial<ResolveInput> = {},
): ResolveInput {
  return {
    catalog: FIXTURE_CATALOG,
    distribution: FIXTURE_DISTRIBUTION,
    instancePolicy: null,
    provenance: "personal-local",
    policyValid: true,
    workspace: null,
    installation: null,
    vault: null,
    receipt: null,
    facts: FIXTURE_FACTS,
    installationId: FIXTURE_INSTALLATION_ID,
    vaultId: null,
    ...overrides,
  };
}

/** A selection document for tests; override any field. */
export function fixtureSelection(
  overrides: Partial<InstallationCapabilitySelection> = {},
): InstallationCapabilitySelection {
  return { ...FIXTURE_INSTALLATION, ...overrides };
}
