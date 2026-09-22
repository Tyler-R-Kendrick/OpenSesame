/**
 * Capability documents as editable resources (S04).
 *
 * The Source view commits through here. The rules are the prefs adapter's:
 * a stale base revision is a conflict, a comments-only edit is a
 * presentation change that touches no semantics, and every semantic change
 * goes through the one door that owns it — the store's `commit` for the
 * selection, the personal-local policy key for a policy authored on this
 * device, the tomb's own key for a vault restriction. A policy that arrived
 * from the deployment or a signature is read-only here: editing it would be
 * forging it.
 */

import type {
  CapabilityCatalog,
  ConsentReceipt,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  VaultCapabilitySelection,
} from "@opensesame/capability-composition";
import { type BoundaryValue, isJsonObject, overlapCast } from "@opensesame/os-domain";
import { kvGet, kvSetDurable } from "../kv.js";
import {
  documentToYaml,
  documentsEqual,
  effectivePlanToYaml,
  parseCapabilityYaml,
  parseInstallationSelectionSource,
  parseInstancePolicySource,
  parseVaultRestrictionSource,
} from "./capabilities-document.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  EFFECTIVE_PLAN_DISPLAY_PATH,
  EFFECTIVE_PLAN_RESOURCE_KEY,
  EFFECTIVE_PLAN_SCHEMA_ID,
  INSTALLATION_SELECTION_DISPLAY_PATH,
  INSTALLATION_SELECTION_RESOURCE_KEY,
  INSTALLATION_SELECTION_SCHEMA_ID,
  INSTANCE_EXPORT_FILE_NAME,
  INSTANCE_POLICY_DISPLAY_PATH,
  INSTANCE_POLICY_RESOURCE_KEY,
  INSTANCE_POLICY_SCHEMA_ID,
  LOCAL_POLICY_KV_KEY,
  LOCAL_POLICY_SOURCE_KV_KEY,
  SELECTION_SOURCE_KV_KEY,
  VAULT_RESTRICTION_DISPLAY_PATH,
  VAULT_RESTRICTION_RESOURCE_KEY,
  VAULT_RESTRICTION_SCHEMA_ID,
  vaultRestrictionKey,
  vaultRestrictionSourceKey,
} from "./capabilities-keys.js";
import {
  CAPABILITY_CATALOG,
  type CommitOutcome,
  type CompositionSnapshot,
  buildConsentReceipt,
  compositionStore,
  previewPlan,
  viewOutcome,
} from "./capabilities-ports.js";
import type { CommitResult, ResourceDescriptor } from "./types.js";
import { isPresentationOnlyChange } from "./yaml-patch.js";

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
    commitSelection: (draft, receipt) => compositionStore.commit(draft, receipt),
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

const RESOURCES: Record<
  CapabilityResourceKind,
  { key: string; path: string; schemaId: string }
> = {
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
  if (kind === "instance-policy") return snapshot.provenance === "personal-local";
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
    capabilities: { default: "deny", required: [], optional: [], prohibited: [] },
    network: { externalServices: "allow", allowedServiceOrigins: [] },
    updates: { unknownCapabilities: "deny", expandedExposure: "require-approval" },
  };
}

function semanticSource(
  kind: CapabilityResourceKind,
  ports: CapabilityConfigPorts,
): string {
  const snapshot = ports.snapshot();
  if (kind === "effective-plan") {
    return snapshot.plan ? effectivePlanToYaml(snapshot.plan) : "";
  }
  if (kind === "instance-policy") {
    const policy =
      snapshot.policy ??
      emptyLocalPolicy(snapshot.plan?.identity.instanceId ?? "personal-local");
    return documentToYaml(overlapCast(policy));
  }
  if (kind === "installation-selection") {
    return snapshot.selection ? documentToYaml(overlapCast(snapshot.selection)) : "";
  }
  const tomb = ports.tomb();
  const stored = tomb ? ports.readKey(vaultRestrictionKey(tomb)) : null;
  if (!stored) return "";
  const parsed = parseCapabilityYaml(stored.trim().startsWith("{") ? jsonToYaml(stored) : stored);
  return parsed.ok ? documentToYaml(overlapCast(parsed.value)) : "";
}

function jsonToYaml(json: string): string {
  try {
    const value: BoundaryValue = JSON.parse(json);
    return isJsonObject(value) ? documentToYaml(value) : "";
  } catch {
    return "";
  }
}

function sourceKey(kind: CapabilityResourceKind, tomb: string | null): string | null {
  if (kind === "instance-policy") return LOCAL_POLICY_SOURCE_KV_KEY;
  if (kind === "installation-selection") return SELECTION_SOURCE_KV_KEY;
  if (kind === "vault-restriction" && tomb) return vaultRestrictionSourceKey(tomb);
  return null;
}

/** Authored bytes when they exist and still say what the document says. */
export function readCapabilitySource(
  kind: CapabilityResourceKind,
  ports: CapabilityConfigPorts,
): string {
  const semantic = semanticSource(kind, ports);
  const key = sourceKey(kind, ports.tomb());
  const authored = key ? ports.readKey(key) : null;
  if (authored && semantic && isPresentationOnlyChange(semantic, authored)) {
    return authored;
  }
  return semantic;
}

type CommitInput = { source: string; baseRevision: string };

function refused(message: string): CommitResult {
  return { status: "refused", message };
}

function applied(
  ports: CapabilityConfigPorts,
  presentation: boolean,
  message: string,
): CommitResult {
  const snapshot = ports.snapshot();
  return {
    status: snapshot.durability === "session-only" ? "applied_ephemeral" : "applied_durable",
    revisionToken: revisionToken(snapshot),
    message: presentation ? "Saved source comments. Nothing else changed." : message,
  };
}

async function guard(
  kind: CapabilityResourceKind,
  ports: CapabilityConfigPorts,
  input: CommitInput,
): Promise<CommitResult | null> {
  const snapshot = ports.snapshot();
  if (!capabilityResourceEditable(kind, snapshot)) {
    return refused("This document is read-only here.");
  }
  if (input.baseRevision !== revisionToken(snapshot)) {
    return {
      status: "conflict",
      message: "This document changed in another session.",
      originalSource: input.source,
      localSource: input.source,
      currentSource: readCapabilitySource(kind, ports),
    };
  }
  return null;
}

export async function commitInstancePolicySource(
  ports: CapabilityConfigPorts,
  input: CommitInput,
): Promise<CommitResult> {
  const blocked = await guard("instance-policy", ports, input);
  if (blocked) return blocked;
  const parsed = parseInstancePolicySource(input.source);
  if (!parsed.ok) return refused(parsed.diagnostics[0]?.message ?? "Invalid policy.");
  const presentation = isPresentationOnlyChange(
    semanticSource("instance-policy", ports),
    input.source,
  );
  try {
    if (!presentation) await saveLocalInstancePolicy(ports, parsed.value);
    await ports.writeKey(LOCAL_POLICY_SOURCE_KV_KEY, input.source);
  } catch (caught) {
    return refused(caught instanceof Error ? caught.message : "Policy was not stored.");
  }
  return applied(ports, presentation, "Instance policy saved on this device.");
}

/** The one writer of `capabilities.policy.local.v1` (personal-local only). */
export async function saveLocalInstancePolicy(
  ports: CapabilityConfigPorts,
  policy: InstanceCapabilityPolicy,
): Promise<void> {
  if (ports.snapshot().provenance !== "personal-local") {
    throw new Error("A managed instance policy cannot be edited on a device.");
  }
  await ports.writeKey(LOCAL_POLICY_KV_KEY, JSON.stringify(policy));
  ports.invalidate("local-policy-updated");
}

export async function commitInstallationSelectionSource(
  ports: CapabilityConfigPorts,
  input: CommitInput,
): Promise<CommitResult> {
  const blocked = await guard("installation-selection", ports, input);
  if (blocked) return blocked;
  const parsed = parseInstallationSelectionSource(input.source);
  if (!parsed.ok) return refused(parsed.diagnostics[0]?.message ?? "Invalid selection.");
  const presentation = isPresentationOnlyChange(
    semanticSource("installation-selection", ports),
    input.source,
  );
  if (presentation) {
    await ports.writeKey(SELECTION_SOURCE_KV_KEY, input.source);
    return applied(ports, true, "");
  }
  const plan = ports.previewPlan(parsed.value);
  const receipt = buildConsentReceipt(plan, ports.catalog(), ports.now());
  const outcome = viewOutcome(await ports.commitSelection(parsed.value, receipt));
  if (outcome.status === "conflict") {
    return {
      status: "conflict",
      message: outcome.message || "The selection changed in another session.",
      originalSource: input.source,
      localSource: input.source,
      currentSource: readCapabilitySource("installation-selection", ports),
    };
  }
  if (outcome.status === "refused") {
    return refused(outcome.message || "The selection was not accepted.");
  }
  await ports.writeKey(SELECTION_SOURCE_KV_KEY, input.source);
  return {
    status: outcome.status === "durable" ? "applied_durable" : "applied_ephemeral",
    revisionToken: revisionToken(ports.snapshot()),
    message: outcome.message || "Installation selection saved.",
  };
}

export async function commitVaultRestrictionSource(
  ports: CapabilityConfigPorts,
  input: CommitInput,
): Promise<CommitResult> {
  const blocked = await guard("vault-restriction", ports, input);
  if (blocked) return blocked;
  const tomb = ports.tomb();
  if (!tomb) return refused("No vault is open.");
  const parsed = parseVaultRestrictionSource(input.source);
  if (!parsed.ok) return refused(parsed.diagnostics[0]?.message ?? "Invalid restriction.");
  if (parsed.value.vaultId !== tomb) {
    return refused("This restriction names another vault.");
  }
  const presentation = isPresentationOnlyChange(
    semanticSource("vault-restriction", ports),
    input.source,
  );
  try {
    if (!presentation) await saveVaultRestriction(ports, tomb, parsed.value);
    await ports.writeKey(vaultRestrictionSourceKey(tomb), input.source);
  } catch (caught) {
    return refused(caught instanceof Error ? caught.message : "Not stored.");
  }
  return applied(ports, presentation, "Vault restriction saved.");
}

export async function saveVaultRestriction(
  ports: CapabilityConfigPorts,
  tomb: string,
  restriction: VaultCapabilitySelection,
): Promise<void> {
  await ports.writeKey(vaultRestrictionKey(tomb), JSON.stringify(restriction));
  ports.invalidate("vault-restriction-updated");
}

/** What leaves the device as a file: policy + selection, never a service. */
export type InstanceConfigurationExport = Readonly<{
  schemaVersion: 1;
  kind: "InstanceConfigurationExport";
  instancePolicy: InstanceCapabilityPolicy | null;
  installationSelection: InstallationCapabilitySelection | null;
}>;

export function instanceConfigurationDocument(
  snapshot: CompositionSnapshot,
): InstanceConfigurationExport {
  return {
    schemaVersion: 1,
    kind: "InstanceConfigurationExport",
    instancePolicy: snapshot.policy,
    installationSelection: snapshot.selection,
  };
}

export function exportInstanceConfiguration(
  snapshot: CompositionSnapshot = compositionStore.getSnapshot(),
): { fileName: string; yaml: string } {
  return {
    fileName: INSTANCE_EXPORT_FILE_NAME,
    yaml: documentToYaml(
      overlapCast(instanceConfigurationDocument(snapshot)),
      "# OpenSesame instance configuration. Policy and selection only; no secret, no service.",
    ),
  };
}

/** The reimport check: `parse(export)` must equal the normalized document. */
export function reimportMatches(
  yaml: string,
  snapshot: CompositionSnapshot,
): boolean {
  const parsed = parseCapabilityYaml(yaml);
  if (!parsed.ok) return false;
  const policy = parsed.value.instancePolicy;
  const selection = parsed.value.installationSelection;
  if (policy !== null && policy !== undefined) {
    if (!parseInstancePolicySource(documentToYaml(policy)).ok) return false;
  }
  if (selection !== null && selection !== undefined) {
    if (!parseInstallationSelectionSource(documentToYaml(selection)).ok) return false;
  }
  return documentsEqual(
    parsed.value,
    overlapCast(instanceConfigurationDocument(snapshot)),
  );
}
