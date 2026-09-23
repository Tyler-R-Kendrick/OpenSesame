/**
 * The `sops` metadata block as upstream `stores/stores.go` and
 * `stores/metadata.go` (26e2f478) read and write it.
 *
 * Reading: a flat layout (`age`, `kms`, `gcp_kms`, `hckms`, `azure_kv`,
 * `hc_vault`, `pgp` at the top) is one key group; `key_groups` lists groups
 * with the same per-type lists. Writing: upstream serializes through a Go
 * map, so keys come out sorted, `omitempty` drops empty lists and zero
 * values, and every group always carries `age` and `hc_vault`.
 *
 * Non-age master keys are kept verbatim (after validation) so a same-DEK
 * edit preserves wrappers this browser cannot open (B08, B10).
 */

import { SopsError } from "./errors.js";
import { MAX_KEY_GROUPS, MAX_RECIPIENT_ENTRIES } from "./limits.js";
import {
  type SopsMap,
  type SopsNode,
  entries,
  entry,
  map,
  scalarText,
} from "./model.js";
import {
  DEFAULT_UNENCRYPTED_SUFFIX,
  type SopsPolicy,
  assertPolicyValid,
} from "./selectors.js";
import { canonicalLastModified } from "./time.js";

export const SOPS_VERSION = "3.13.3";
export const SUPPORTED_VERSION = /^3\.(?:[7-9]|1[0-3])\.\d+$/u;

export type MasterKeyKind =
  | "age"
  | "kms"
  | "gcp_kms"
  | "hckms"
  | "azure_kv"
  | "hc_vault"
  | "pgp";

export const MASTER_KEY_KINDS: readonly MasterKeyKind[] = [
  "age",
  "kms",
  "gcp_kms",
  "hckms",
  "azure_kv",
  "hc_vault",
  "pgp",
];

const MASTER_KEY_KIND_SET: ReadonlySet<string> = new Set(MASTER_KEY_KINDS);

export type AgeMasterKey = { kind: "age"; recipient: string; enc: string };

/** A non-age wrapper, validated to carry `enc` and kept verbatim otherwise. */
export type ForeignMasterKey = {
  kind: Exclude<MasterKeyKind, "age">;
  enc: string;
  /** Untrusted locator for display: arn, resource_id, vault url, fingerprint. */
  locator: string;
  raw: SopsMap;
};

export type SopsMasterKey = AgeMasterKey | ForeignMasterKey;

export type SopsKeyGroup = { keys: SopsMasterKey[] };

export type SopsMetadata = {
  layout: "flat" | "groups";
  groups: SopsKeyGroup[];
  /** As written; 0 means upstream's default of every group. */
  shamirThreshold: number;
  lastModified: string;
  mac: string;
  policy: SopsPolicy;
  version: string;
};

const LOCATOR_KEY = {
  kms: "arn",
  gcp_kms: "resource_id",
  hckms: "key_id",
  azure_kv: "vault_url",
  hc_vault: "vault_address",
  pgp: "fp",
} satisfies Record<Exclude<MasterKeyKind, "age">, string>;

const KNOWN_TOP = new Set([
  ...MASTER_KEY_KINDS,
  "key_groups",
  "shamir_threshold",
  "lastmodified",
  "mac",
  "unencrypted_suffix",
  "encrypted_suffix",
  "unencrypted_regex",
  "encrypted_regex",
  "unencrypted_comment_regex",
  "encrypted_comment_regex",
  "mac_only_encrypted",
  "version",
]);

function invalid(message: string): SopsError {
  return new SopsError("invalid_metadata", message);
}

function textOf(node: SopsNode | undefined, name: string): string {
  if (node === undefined) return "";
  const value = scalarText(node);
  if (value === undefined) throw invalid(`sops.${name} is not a string.`);
  return value;
}

function boolOf(node: SopsNode | undefined, name: string): boolean {
  if (node === undefined) return false;
  if (node.kind !== "scalar" || node.scalar.kind !== "bool") {
    throw invalid(`sops.${name} is not a boolean.`);
  }
  return node.scalar.value;
}

function intOf(node: SopsNode | undefined, name: string): number {
  if (node === undefined) return 0;
  if (node.kind !== "scalar" || node.scalar.kind !== "int") {
    throw invalid(`sops.${name} is not an integer.`);
  }
  const value = Number(node.scalar.value);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_KEY_GROUPS) {
    throw invalid(`sops.${name} is out of range.`);
  }
  return value;
}

function parseKeyList(
  kind: MasterKeyKind,
  node: SopsNode | undefined,
): SopsMasterKey[] {
  if (node === undefined || node.kind === "null") return [];
  if (node.kind !== "seq") throw invalid(`sops.${kind} is not a list.`);
  const keys: SopsMasterKey[] = [];
  for (const item of node.items) {
    if (item.kind !== "map")
      throw invalid(`sops.${kind} holds a non-mapping entry.`);
    const enc = textOf(entry(item, "enc"), `${kind}.enc`);
    if (kind === "age") {
      const recipient = textOf(
        entry(item, "recipient"),
        "age.recipient",
      ).trim();
      if (recipient === "") throw invalid("An age entry has no recipient.");
      for (const field of entries(item)) {
        if (field.key !== "enc" && field.key !== "recipient") {
          throw invalid("An age entry carries an unknown field.");
        }
      }
      keys.push({ kind: "age", recipient, enc });
      continue;
    }
    const locator = textOf(
      entry(item, LOCATOR_KEY[kind]),
      `${kind}.${LOCATOR_KEY[kind]}`,
    );
    keys.push({ kind, enc, locator, raw: item });
  }
  return keys;
}

function parseGroup(node: SopsNode, where: string): SopsKeyGroup {
  if (node.kind !== "map") throw invalid(`${where} is not a mapping.`);
  const keys: SopsMasterKey[] = [];
  for (const field of entries(node)) {
    if (!MASTER_KEY_KIND_SET.has(field.key)) {
      throw invalid(`${where} names an unknown master key type.`);
    }
  }
  // Upstream's internal order: kms, gcp_kms, hckms, azure_kv, hc_vault, pgp, age.
  for (const kind of [
    "kms",
    "gcp_kms",
    "hckms",
    "azure_kv",
    "hc_vault",
    "pgp",
    "age",
  ] as const) {
    keys.push(...parseKeyList(kind, entry(node, kind)));
  }
  return { keys };
}

type ParsedGroups = { layout: SopsMetadata["layout"]; groups: SopsKeyGroup[] };

function parseGroups(sops: SopsNode): ParsedGroups {
  const flat = parseGroup(
    map(entries(sops).filter((field) => MASTER_KEY_KIND_SET.has(field.key))),
    "sops",
  );
  const groupsNode = entry(sops, "key_groups");
  if (flat.keys.length > 0) {
    if (groupsNode !== undefined)
      throw invalid("sops mixes flat master keys with key_groups.");
    return { layout: "flat", groups: [flat] };
  }
  if (groupsNode === undefined)
    throw invalid("No master keys found in sops metadata.");
  if (groupsNode.kind !== "seq")
    throw invalid("sops.key_groups is not a list.");
  const groups = groupsNode.items.map((item, index) => {
    if (item.kind === "comment")
      throw invalid("sops.key_groups holds a comment.");
    return parseGroup(item, `sops.key_groups[${index}]`);
  });
  return { layout: "groups", groups };
}

function assertGroupBudget(groups: readonly SopsKeyGroup[]): void {
  if (groups.length === 0) throw invalid("sops.key_groups is empty.");
  if (groups.length > MAX_KEY_GROUPS)
    throw new SopsError("resource_limit", "Too many key groups.");
  let total = 0;
  for (const group of groups) {
    if (group.keys.length === 0) throw invalid("A key group is empty.");
    total += group.keys.length;
  }
  if (total > MAX_RECIPIENT_ENTRIES) {
    throw new SopsError("resource_limit", "Too many master key entries.");
  }
}

function parsePolicy(sops: SopsNode): SopsPolicy {
  const policy: SopsPolicy = {
    unencryptedSuffix: textOf(
      entry(sops, "unencrypted_suffix"),
      "unencrypted_suffix",
    ),
    encryptedSuffix: textOf(
      entry(sops, "encrypted_suffix"),
      "encrypted_suffix",
    ),
    unencryptedRegex: textOf(
      entry(sops, "unencrypted_regex"),
      "unencrypted_regex",
    ),
    encryptedRegex: textOf(entry(sops, "encrypted_regex"), "encrypted_regex"),
    unencryptedCommentRegex: textOf(
      entry(sops, "unencrypted_comment_regex"),
      "unencrypted_comment_regex",
    ),
    encryptedCommentRegex: textOf(
      entry(sops, "encrypted_comment_regex"),
      "encrypted_comment_regex",
    ),
    macOnlyEncrypted: boolOf(
      entry(sops, "mac_only_encrypted"),
      "mac_only_encrypted",
    ),
  };
  assertPolicyValid(policy);
  const anySelector = [
    policy.unencryptedSuffix,
    policy.encryptedSuffix,
    policy.unencryptedRegex,
    policy.encryptedRegex,
    policy.unencryptedCommentRegex,
    policy.encryptedCommentRegex,
  ].some((rule) => rule !== "");
  if (!anySelector) policy.unencryptedSuffix = DEFAULT_UNENCRYPTED_SUFFIX;
  return policy;
}

/** Parse and validate a `sops` block. Never reads key material. */
export function parseSopsMetadata(sops: SopsNode): SopsMetadata {
  if (sops.kind !== "map") throw invalid("sops is not a mapping.");
  for (const field of entries(sops)) {
    if (!KNOWN_TOP.has(field.key)) {
      throw invalid("sops carries a field this engine does not understand.");
    }
  }
  const { layout, groups } = parseGroups(sops);
  assertGroupBudget(groups);
  const shamirThreshold = intOf(
    entry(sops, "shamir_threshold"),
    "shamir_threshold",
  );
  if (groups.length > 1 && shamirThreshold > groups.length) {
    throw invalid("sops.shamir_threshold exceeds the number of key groups.");
  }
  const version = textOf(entry(sops, "version"), "version");
  if (!SUPPORTED_VERSION.test(version)) {
    throw new SopsError(
      "unsupported_version",
      "sops.version is outside the tested range.",
    );
  }
  const mac = textOf(entry(sops, "mac"), "mac");
  const lastModified = canonicalLastModified(
    textOf(entry(sops, "lastmodified"), "lastmodified"),
  );
  return {
    layout,
    groups,
    shamirThreshold,
    lastModified,
    mac,
    policy: parsePolicy(sops),
    version,
  };
}
