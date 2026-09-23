/**
 * Inert inspection (B13, SB-050): bounded parsing and untrusted metadata
 * facts. Nothing here reads an identity, contacts a provider, or decrypts.
 */

import { type SopsFormat, loadFile } from "./document.js";
import { effectiveThreshold } from "./metadata-emit.js";
import { SOPS_VERSION, type SopsMetadata } from "./metadata.js";
import type { SopsPolicy } from "./selectors.js";

export const SOPS_PROFILE = `sops-browser/${SOPS_VERSION}/yaml-json-age`;

export type UntrustedKeyEntry = {
  kind: SopsMetadata["groups"][number]["keys"][number]["kind"];
  /** Recipient or provider locator as written in the file; untrusted. */
  locator: string;
  /** True when this browser holds a code path that can open the entry. */
  browserOpenable: boolean;
};

export type UntrustedKeyGroupSummary = { entries: UntrustedKeyEntry[] };

export type IntegrityMode =
  | "all-supported-values"
  | "encrypted-values-only"
  | "unknown";

export type Inspection = {
  format: SopsFormat;
  encrypted: boolean;
  profile: string;
  version: string;
  documents: number;
  keyGroups: UntrustedKeyGroupSummary[];
  shamirThreshold: number;
  requiredGroups: number;
  integrityMode: IntegrityMode;
  policy: SopsPolicy | null;
  /** Safe, redacted facts about the document's shape. */
  featureDiagnostics: string[];
};

export function inspectText(text: string, format: SopsFormat): Inspection {
  const loaded = loadFile(text, format);
  const meta = loaded.metadata;
  const diagnostics: string[] = [];
  if (loaded.roots.length > 1)
    diagnostics.push(`${loaded.roots.length} YAML documents`);
  if (!meta) {
    return {
      format,
      encrypted: false,
      profile: SOPS_PROFILE,
      version: "",
      documents: loaded.roots.length,
      keyGroups: [],
      shamirThreshold: 0,
      requiredGroups: 0,
      integrityMode: "unknown",
      policy: null,
      featureDiagnostics: diagnostics,
    };
  }
  const keyGroups = meta.groups.map((group) => ({
    entries: group.keys.map((key) => ({
      kind: key.kind,
      locator: key.kind === "age" ? key.recipient : key.locator,
      browserOpenable: key.kind === "age",
    })),
  }));
  if (meta.groups.length > 1)
    diagnostics.push(`${meta.groups.length} key groups`);
  if (meta.policy.macOnlyEncrypted) diagnostics.push("mac_only_encrypted");
  return {
    format,
    encrypted: true,
    profile: SOPS_PROFILE,
    version: meta.version,
    documents: loaded.roots.length,
    keyGroups,
    shamirThreshold: meta.shamirThreshold,
    requiredGroups: effectiveThreshold(meta),
    integrityMode: meta.policy.macOnlyEncrypted
      ? "encrypted-values-only"
      : "all-supported-values",
    policy: meta.policy,
    featureDiagnostics: diagnostics,
  };
}
