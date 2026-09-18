import type { VaultPrefs } from "../vault/store.js";
import {
  type PrefsDocument,
  parsePrefsSource,
  prefsToYaml,
} from "./prefs-document.js";
import {
  PREFS_RESOURCE_KEY,
  PREFS_SCHEMA_ID,
  PREFS_SCHEMA_VERSION,
} from "./prefs-keys.js";
import type { CommitResult, ResourceDescriptor } from "./types.js";
import { isPresentationOnlyChange } from "./yaml-patch.js";

export type PrefsPorts = {
  readPrefs: () => VaultPrefs;
  tomb: () => string;
  revisionToken: () => string;
  writeSemantic: (prefs: PrefsDocument) => Promise<void>;
  writeSource?: (yaml: string) => Promise<void>;
  readSource?: () => Promise<string | null>;
};

export function prefsResource(
  revisionToken: string,
  persistence: ResourceDescriptor["persistence"] = "durable",
): ResourceDescriptor {
  return {
    resourceKey: PREFS_RESOURCE_KEY,
    displayPath: "settings/prefs.yaml",
    ownerPlane: "client_local",
    schemaId: PREFS_SCHEMA_ID,
    schemaVersion: PREFS_SCHEMA_VERSION,
    capabilities: {
      read: true,
      edit: true,
      history: true,
      export: true,
      compare: true,
      test: false,
    },
    revisionToken,
    sensitivity: "metadata",
    persistence,
  };
}

export async function readPrefsDraftSource(ports: PrefsPorts): Promise<string> {
  const authored = ports.readSource ? await ports.readSource() : null;
  if (authored !== null && authored !== "") return authored;
  return prefsToYaml(ports.readPrefs());
}

export async function commitPrefsSource(
  ports: PrefsPorts,
  input: {
    source: string;
    baseRevision: string;
  },
): Promise<CommitResult> {
  const currentRevision = ports.revisionToken();
  if (input.baseRevision !== currentRevision) {
    const currentSource = await readPrefsDraftSource(ports);
    return {
      status: "conflict",
      message: "This document changed in another session.",
      originalSource: input.source,
      localSource: input.source,
      currentSource,
    };
  }
  const parsed = parsePrefsSource(input.source);
  if (!parsed.ok) {
    return {
      status: "refused",
      message:
        parsed.diagnostics[0]?.message ?? "Invalid preferences document.",
    };
  }
  const previous = prefsToYaml(ports.readPrefs());
  const presentation = isPresentationOnlyChange(previous, input.source);
  try {
    if (!presentation) await ports.writeSemantic(parsed.value);
    if (ports.writeSource) await ports.writeSource(input.source);
    return {
      status: "applied_durable",
      revisionToken: ports.revisionToken(),
      message: presentation
        ? "Saved source comments. Vault access was not changed."
        : "Preferences saved.",
    };
  } catch (caught) {
    return {
      status: "refused",
      message:
        caught instanceof Error
          ? caught.message
          : "Preferences were not stored.",
    };
  }
}
