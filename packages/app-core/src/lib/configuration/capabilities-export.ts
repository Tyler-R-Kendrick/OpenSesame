/**
 * Export and reimport of the instance configuration (S04, CONSENT-10).
 *
 * A file, never a service: the policy and the selection as one YAML
 * document, and the check that reading it back yields exactly the document
 * it was made from.
 */

import type {
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
} from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import {
  documentToYaml,
  documentsEqual,
  parseCapabilityYaml,
  parseInstallationSelectionSource,
  parseInstancePolicySource,
} from "./capabilities-document.js";
import { INSTANCE_EXPORT_FILE_NAME } from "./capabilities-keys.js";
import {
  type CompositionSnapshot,
  capabilityPorts,
} from "./capabilities-ports.js";

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

/** The file the Export control hands the person: a name and YAML bytes. */
export type InstanceConfigurationFile = Readonly<{
  fileName: string;
  yaml: string;
}>;

export function exportInstanceConfiguration(
  snapshot: CompositionSnapshot = capabilityPorts.compositionStore.getSnapshot(),
): InstanceConfigurationFile {
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
    if (!parseInstallationSelectionSource(documentToYaml(selection)).ok)
      return false;
  }
  return documentsEqual(
    parsed.value,
    overlapCast(instanceConfigurationDocument(snapshot)),
  );
}
