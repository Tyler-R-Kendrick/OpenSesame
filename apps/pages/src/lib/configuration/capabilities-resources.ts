/**
 * Capability resources — descriptors, ports and the editable/read-only rule
 * (S04). `capabilities-adapter.ts` commits through these; nothing here
 * writes.
 */

import type {
  CapabilityCatalog,
  ConsentReceipt,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
} from "@opensesame/capability-composition";
import { kvGet, kvSetDurable } from "../kv.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  EFFECTIVE_PLAN_DISPLAY_PATH,
  EFFECTIVE_PLAN_RESOURCE_KEY,
  EFFECTIVE_PLAN_SCHEMA_ID,
  INSTALLATION_SELECTION_DISPLAY_PATH,
  INSTALLATION_SELECTION_RESOURCE_KEY,
  INSTALLATION_SELECTION_SCHEMA_ID,
  INSTANCE_POLICY_DISPLAY_PATH,
  INSTANCE_POLICY_RESOURCE_KEY,
  INSTANCE_POLICY_SCHEMA_ID,
  VAULT_RESTRICTION_DISPLAY_PATH,
  VAULT_RESTRICTION_RESOURCE_KEY,
  VAULT_RESTRICTION_SCHEMA_ID,
} from "./capabilities-keys.js";
import {
  CAPABILITY_CATALOG,
  type CommitOutcome,
  type CompositionSnapshot,
  compositionStore,
  previewPlan,
} from "./capabilities-ports.js";
import type { ResourceDescriptor } from "./types.js";

export type CapabilityConfigPorts = {
  snapshot: () => CompositionSnapshot;
  catalog: () => CapabilityCatalog;
  previewPlan: (draft: InstallationCapabilitySelection) => EffectivePlan;
  commitSelection: (
    draft: InstallationCapabilitySelection,
    receipt: ConsentReceipt,
  ) => Promise<CommitOutcome>;
  invalidate: (reason: string) => void;
  now: () => string;
  readKey: (key: string) => string | null;
  writeKey: (key: string, value: string) => Promise<void>;
  /** The tomb a vault restriction belongs to; null before unlock. */
  tomb: () => string | null;
};

export function defaultCapabilityPorts(
  tomb: () => string | null,
): CapabilityConfigPorts {
  return {
    snapshot: () => compositionStore.getSnapshot(),
    catalog: () => CAPABILITY_CATALOG,
    previewPlan,
    commitSelection: (draft, receipt) =>
      compositionStore.commit(draft, receipt),
    invalidate: (reason) => compositionStore.invalidate(reason),
    now: () => new Date().toISOString(),
    readKey: kvGet,
    writeKey: kvSetDurable,
    tomb,
  };
}

export type CapabilityResourceKind =
  | "instance-policy"
  | "installation-selection"
  | "vault-restriction"
  | "effective-plan";

/** Where one capability resource lives, and which schema names it. */
export type CapabilityResourceLocation = Readonly<{
  key: string;
  path: string;
  schemaId: string;
}>;

type CapabilityResourceTable = Record<
  CapabilityResourceKind,
  CapabilityResourceLocation
>;

const RESOURCES: CapabilityResourceTable = {
  "instance-policy": {
    key: INSTANCE_POLICY_RESOURCE_KEY,
    path: INSTANCE_POLICY_DISPLAY_PATH,
    schemaId: INSTANCE_POLICY_SCHEMA_ID,
  },
  "installation-selection": {
    key: INSTALLATION_SELECTION_RESOURCE_KEY,
    path: INSTALLATION_SELECTION_DISPLAY_PATH,
    schemaId: INSTALLATION_SELECTION_SCHEMA_ID,
  },
  "vault-restriction": {
    key: VAULT_RESTRICTION_RESOURCE_KEY,
    path: VAULT_RESTRICTION_DISPLAY_PATH,
    schemaId: VAULT_RESTRICTION_SCHEMA_ID,
  },
  "effective-plan": {
    key: EFFECTIVE_PLAN_RESOURCE_KEY,
    path: EFFECTIVE_PLAN_DISPLAY_PATH,
    schemaId: EFFECTIVE_PLAN_SCHEMA_ID,
  },
};

/** Whether the Source view may write this kind under this snapshot. */
export function capabilityResourceEditable(
  kind: CapabilityResourceKind,
  snapshot: CompositionSnapshot,
): boolean {
  if (kind === "effective-plan") return false;
  if (kind === "instance-policy")
    return snapshot.provenance === "personal-local";
  return true;
}

export function revisionToken(snapshot: CompositionSnapshot): string {
  return `${snapshot.generation}:${snapshot.policy?.revision ?? "-"}:${
    snapshot.selection?.revision ?? "-"
  }`;
}

export function capabilityResource(
  kind: CapabilityResourceKind,
  snapshot: CompositionSnapshot,
): ResourceDescriptor {
  const entry = RESOURCES[kind];
  const edit = capabilityResourceEditable(kind, snapshot);
  return {
    resourceKey: entry.key,
    displayPath: entry.path,
    ownerPlane: "client_local",
    schemaId: entry.schemaId,
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    capabilities: {
      read: true,
      edit,
      history: false,
      export: kind !== "vault-restriction",
      compare: true,
      test: false,
    },
    revisionToken: revisionToken(snapshot),
    sensitivity: "metadata",
    persistence:
      snapshot.durability === "durable"
        ? "durable"
        : snapshot.durability === "session-only"
          ? "ephemeral"
          : "unavailable",
  };
}

/** A personal-local policy before one is authored: every optional permitted. */
export function emptyLocalPolicy(instanceId: string): InstanceCapabilityPolicy {
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId,
    revision: "0",
    presetProvenance: null,
    capabilities: {
      default: "deny",
      required: [],
      optional: [],
      prohibited: [],
    },
    network: { externalServices: "allow", allowedServiceOrigins: [] },
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  };
}
