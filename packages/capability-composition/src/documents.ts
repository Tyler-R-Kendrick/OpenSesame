/**
 * Strict parsers for the policy and selection documents.
 *
 * A document is accepted only when every field is present, typed, bounded,
 * and known. A security-relevant field with an unexpected value (a
 * `capabilities.default` other than `deny`, an `updates` block other than
 * the one fixed shape) makes the whole document invalid: there is no
 * lenient mode and no default fill-in.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { type Diagnostic, type ParseResult, parseResultOf } from "./diagnostics.js";
import { MAX_OPAQUE_ID_LENGTH, isCapabilityId } from "./ids.js";
import {
  MAX_ORIGIN_LENGTH,
  type ObjectReader,
  REVISION_BOUNDS,
  checkDisjoint,
  isSlotName,
  rootReader,
} from "./parse-fields.js";
import type {
  DeliveryPreference,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  NetworkPolicy,
  PresetProvenance,
  UpdatesPolicy,
  VaultCapabilitySelection,
  WorkspaceCapabilityRestriction,
} from "./types.js";

const ORIGIN_BOUNDS = {
  min: 1,
  max: MAX_ORIGIN_LENGTH,
  pattern: /^\S+$/,
} as const;
const MAX_PRESET_VERSION = 2 ** 31 - 1;

function readPresetProvenance(
  reader: ObjectReader,
): PresetProvenance | null | undefined {
  const preset = reader.nullableObject("presetProvenance");
  if (preset === undefined || preset === null) return preset;
  const id = preset.string("id", { min: 1, max: MAX_OPAQUE_ID_LENGTH });
  const version = preset.nonNegativeInteger("version", MAX_PRESET_VERSION);
  preset.finish();
  if (id === undefined || version === undefined) return undefined;
  return { id, version };
}

function readNetwork(reader: ObjectReader): NetworkPolicy | undefined {
  const network = reader.object("network");
  if (network === undefined) return undefined;
  const externalServices = network.enumOf("externalServices", ["allow", "deny"]);
  const allowedServiceOrigins = network.stringList("allowedServiceOrigins", ORIGIN_BOUNDS);
  network.finish();
  if (externalServices === undefined || allowedServiceOrigins === undefined) {
    return undefined;
  }
  return { externalServices, allowedServiceOrigins };
}

function readUpdates(reader: ObjectReader): UpdatesPolicy | undefined {
  const updates = reader.object("updates");
  if (updates === undefined) return undefined;
  const unknownCapabilities = updates.literal("unknownCapabilities", "deny");
  const expandedExposure = updates.literal("expandedExposure", "require-approval");
  updates.finish();
  if (unknownCapabilities === undefined || expandedExposure === undefined) {
    return undefined;
  }
  return { unknownCapabilities, expandedExposure };
}

function readPolicyCapabilities(
  reader: ObjectReader,
): InstanceCapabilityPolicy["capabilities"] | undefined {
  const caps = reader.object("capabilities");
  if (caps === undefined) return undefined;
  const fallback = caps.literal("default", "deny");
  const required = caps.idList("required");
  const optional = caps.idList("optional");
  const prohibited = caps.idList("prohibited");
  caps.finish();
  if (
    fallback === undefined ||
    required === undefined ||
    optional === undefined ||
    prohibited === undefined
  ) {
    return undefined;
  }
  checkDisjoint(caps, [
    { name: "required", path: `${caps.path}.required`, ids: required },
    { name: "optional", path: `${caps.path}.optional`, ids: optional },
    { name: "prohibited", path: `${caps.path}.prohibited`, ids: prohibited },
  ]);
  return { default: fallback, required, optional, prohibited };
}

export function parseInstancePolicy(
  v: BoundaryValue,
): ParseResult<InstanceCapabilityPolicy> {
  const diags: Diagnostic[] = [];
  const reader = rootReader(v, diags);
  if (reader === undefined) return parseResultOf(diags, undefined);
  const schemaVersion = reader.literal("schemaVersion", 1);
  const kind = reader.literal("kind", "InstanceCapabilityPolicy");
  const instanceId = reader.opaqueId("instanceId");
  const revision = reader.string("revision", REVISION_BOUNDS);
  const presetProvenance = readPresetProvenance(reader);
  const capabilities = readPolicyCapabilities(reader);
  const network = readNetwork(reader);
  const updates = readUpdates(reader);
  reader.finish();
  if (
    schemaVersion === undefined ||
    kind === undefined ||
    instanceId === undefined ||
    revision === undefined ||
    presetProvenance === undefined ||
    capabilities === undefined ||
    network === undefined ||
    updates === undefined
  ) {
    return parseResultOf(diags, undefined);
  }
  return parseResultOf(diags, {
    schemaVersion,
    kind,
    instanceId,
    revision,
    presetProvenance,
    capabilities,
    network,
    updates,
  });
}

export function parseWorkspaceRestriction(
  v: BoundaryValue,
): ParseResult<WorkspaceCapabilityRestriction> {
  const diags: Diagnostic[] = [];
  const reader = rootReader(v, diags);
  if (reader === undefined) return parseResultOf(diags, undefined);
  const schemaVersion = reader.literal("schemaVersion", 1);
  const kind = reader.literal("kind", "WorkspaceCapabilityRestriction");
  const instanceId = reader.opaqueId("instanceId");
  const vaultId = reader.opaqueId("vaultId");
  const revision = reader.string("revision", REVISION_BOUNDS);
  const allow = reader.nullableIdList("allow");
  const prohibited = reader.idList("prohibited");
  reader.finish();
  if (
    schemaVersion === undefined ||
    kind === undefined ||
    instanceId === undefined ||
    vaultId === undefined ||
    revision === undefined ||
    allow === undefined ||
    prohibited === undefined
  ) {
    return parseResultOf(diags, undefined);
  }
  if (allow !== null) {
    checkDisjoint(reader, [
      { name: "allow", path: "allow", ids: allow },
      { name: "prohibited", path: "prohibited", ids: prohibited },
    ]);
  }
  return parseResultOf(diags, {
    schemaVersion,
    kind,
    instanceId,
    vaultId,
    revision,
    allow,
    prohibited,
  });
}

function readDelivery(reader: ObjectReader): DeliveryPreference | undefined {
  const delivery = reader.object("delivery");
  if (delivery === undefined) return undefined;
  const prefetch = delivery.enumOf("prefetch", ["none", "selected"]);
  const offlineCache = delivery.enumOf("offlineCache", ["shell-only", "selected-only"]);
  delivery.finish();
  if (prefetch === undefined || offlineCache === undefined) return undefined;
  return { prefetch, offlineCache };
}

export function parseInstallationSelection(
  v: BoundaryValue,
): ParseResult<InstallationCapabilitySelection> {
  const diags: Diagnostic[] = [];
  const reader = rootReader(v, diags);
  if (reader === undefined) return parseResultOf(diags, undefined);
  const schemaVersion = reader.literal("schemaVersion", 1);
  const kind = reader.literal("kind", "InstallationCapabilitySelection");
  const instanceId = reader.opaqueId("instanceId");
  const installationId = reader.opaqueId("installationId");
  const basePolicyRevision = reader.string("basePolicyRevision", REVISION_BOUNDS);
  const revision = reader.string("revision", REVISION_BOUNDS);
  const acceptedRequired = reader.idList("acceptedRequired");
  const selectedOptional = reader.idList("selectedOptional");
  const chosenAlternatives = reader.record(
    "chosenAlternatives",
    isSlotName,
    "slot name must match ^[a-z][a-z0-9-]*$ and be at most 64 characters",
    isCapabilityId,
    "choice is not a capability id",
  );
  const delivery = readDelivery(reader);
  reader.finish();
  if (
    schemaVersion === undefined ||
    kind === undefined ||
    instanceId === undefined ||
    installationId === undefined ||
    basePolicyRevision === undefined ||
    revision === undefined ||
    acceptedRequired === undefined ||
    selectedOptional === undefined ||
    chosenAlternatives === undefined ||
    delivery === undefined
  ) {
    return parseResultOf(diags, undefined);
  }
  checkDisjoint(reader, [
    { name: "acceptedRequired", path: "acceptedRequired", ids: acceptedRequired },
    { name: "selectedOptional", path: "selectedOptional", ids: selectedOptional },
  ]);
  return parseResultOf(diags, {
    schemaVersion,
    kind,
    instanceId,
    installationId,
    basePolicyRevision,
    revision,
    acceptedRequired,
    selectedOptional,
    chosenAlternatives,
    delivery,
  });
}

export function parseVaultSelection(
  v: BoundaryValue,
): ParseResult<VaultCapabilitySelection> {
  const diags: Diagnostic[] = [];
  const reader = rootReader(v, diags);
  if (reader === undefined) return parseResultOf(diags, undefined);
  const schemaVersion = reader.literal("schemaVersion", 1);
  const kind = reader.literal("kind", "VaultCapabilitySelection");
  const instanceId = reader.opaqueId("instanceId");
  const installationId = reader.opaqueId("installationId");
  const vaultId = reader.opaqueId("vaultId");
  const revision = reader.string("revision", REVISION_BOUNDS);
  const disabled = reader.idList("disabled");
  reader.finish();
  if (
    schemaVersion === undefined ||
    kind === undefined ||
    instanceId === undefined ||
    installationId === undefined ||
    vaultId === undefined ||
    revision === undefined ||
    disabled === undefined
  ) {
    return parseResultOf(diags, undefined);
  }
  return parseResultOf(diags, {
    schemaVersion,
    kind,
    instanceId,
    installationId,
    vaultId,
    revision,
    disabled,
  });
}
