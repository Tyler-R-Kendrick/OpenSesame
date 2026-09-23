/**
 * `.sops.yaml` creation rules as upstream `config/config.go` (26e2f478)
 * interprets them, for an explicitly selected config only (B09, SB-044):
 *
 *  - the first rule whose `path_regex` matches the document's logical path
 *    relative to the config's directory wins; a rule without `path_regex`
 *    matches everything;
 *  - `age` may be a comma-separated string or a list; `key_groups` lists
 *    groups (with `merge`), and only age members are usable here;
 *  - at most one selector rule per creation rule.
 *
 * There is no directory search, no `destination_rules`, no `stores`
 * configuration, and nothing in a config can name a command, a URL to
 * fetch, a plugin, or a key service. Unsupported operative keys are refused,
 * not ignored.
 */

import { SopsError } from "./errors.js";
import { parseAgeRecipient } from "./keys/age.js";
import type { WrapTarget } from "./keys/groups.js";
import { MAX_CONFIG_BYTES, MAX_CONFIG_RULES } from "./limits.js";
import { type SopsNode, entries, entry } from "./model.js";
import { type EncryptionPlan, validatePlan } from "./plan.js";
import { DEFAULT_POLICY, type SopsPolicy, matchRe2 } from "./selectors.js";
import { parseYamlDocuments } from "./yaml-parse.js";

const RULE_KEYS = new Set([
  "path_regex",
  "age",
  "key_groups",
  "shamir_threshold",
  "unencrypted_suffix",
  "encrypted_suffix",
  "unencrypted_regex",
  "encrypted_regex",
  "unencrypted_comment_regex",
  "encrypted_comment_regex",
  "mac_only_encrypted",
]);

/** Cloud master keys a rule may name; understood but not yet executable here. */
const CLOUD_RULE_KEYS = new Set([
  "kms",
  "gcp_kms",
  "azure_keyvault",
  "hc_vault_transit_uri",
  "pgp",
  "hckms",
  "aws_profile",
]);

export type CreationRule = {
  pathRegex: string;
  groups: readonly (readonly WrapTarget[])[];
  shamirThreshold: number;
  policy: SopsPolicy;
  /** Master key kinds the rule names that this browser cannot wrap. */
  unsupported: string[];
};

export type SopsConfig = { rules: CreationRule[] };

function refuse(message: string): SopsError {
  return new SopsError("unauthorized_policy", message);
}

function textOf(node: SopsNode | undefined): string {
  if (node === undefined || node.kind === "null") return "";
  if (node.kind !== "scalar") throw refuse("A config value is not a scalar.");
  const scalar = node.scalar;
  if (scalar.kind === "str" || scalar.kind === "int") return scalar.value;
  if (scalar.kind === "bool") return scalar.value ? "true" : "false";
  throw refuse("A config value has an unexpected type.");
}

function recipientsOf(node: SopsNode | undefined): string[] {
  if (node === undefined || node.kind === "null") return [];
  if (node.kind === "scalar") {
    return textOf(node)
      .split(",")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map(parseAgeRecipient);
  }
  if (node.kind === "seq") {
    return node.items.map((item) => {
      if (item.kind === "comment")
        throw refuse("A config list holds a comment.");
      return parseAgeRecipient(textOf(item));
    });
  }
  throw refuse("age must be a string or a list.");
}

function groupOf(node: SopsNode, unsupported: string[]): WrapTarget[] {
  if (node.kind !== "map") throw refuse("A key group is not a mapping.");
  const targets: WrapTarget[] = [];
  for (const field of entries(node)) {
    if (field.key === "merge") {
      if (field.value.kind !== "seq")
        throw refuse("merge must be a list of groups.");
      for (const item of field.value.items) {
        if (item.kind === "comment") continue;
        targets.push(...groupOf(item, unsupported));
      }
    } else if (field.key === "age") {
      targets.push(
        ...recipientsOf(field.value).map((recipient) => ({
          kind: "age" as const,
          recipient,
        })),
      );
    } else if (CLOUD_RULE_KEYS.has(field.key)) {
      unsupported.push(field.key);
    } else {
      throw refuse("A key group names an unsupported master key type.");
    }
  }
  // Upstream deduplicates identical members within a group.
  const seen = new Set<string>();
  return targets.filter((target) => {
    const id = target.kind === "age" ? target.recipient : target.kind;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function ruleOf(node: SopsNode): CreationRule {
  if (node.kind !== "map") throw refuse("A creation rule is not a mapping.");
  const unsupported: string[] = [];
  for (const field of entries(node)) {
    if (RULE_KEYS.has(field.key)) continue;
    if (CLOUD_RULE_KEYS.has(field.key)) {
      unsupported.push(field.key);
      continue;
    }
    throw refuse("A creation rule carries a key this engine does not honor.");
  }
  const groupsNode = entry(node, "key_groups");
  let groups: WrapTarget[][];
  if (groupsNode !== undefined) {
    if (groupsNode.kind !== "seq") throw refuse("key_groups must be a list.");
    groups = groupsNode.items.map((item) => {
      if (item.kind === "comment") throw refuse("key_groups holds a comment.");
      return groupOf(item, unsupported);
    });
  } else {
    groups = [
      recipientsOf(entry(node, "age")).map((recipient) => ({
        kind: "age" as const,
        recipient,
      })),
    ];
  }
  const policy: SopsPolicy = {
    ...DEFAULT_POLICY,
    unencryptedSuffix: textOf(entry(node, "unencrypted_suffix")),
    encryptedSuffix: textOf(entry(node, "encrypted_suffix")),
    unencryptedRegex: textOf(entry(node, "unencrypted_regex")),
    encryptedRegex: textOf(entry(node, "encrypted_regex")),
    unencryptedCommentRegex: textOf(entry(node, "unencrypted_comment_regex")),
    encryptedCommentRegex: textOf(entry(node, "encrypted_comment_regex")),
    macOnlyEncrypted: textOf(entry(node, "mac_only_encrypted")) === "true",
  };
  const anySelector = [
    policy.unencryptedSuffix,
    policy.encryptedSuffix,
    policy.unencryptedRegex,
    policy.encryptedRegex,
    policy.unencryptedCommentRegex,
    policy.encryptedCommentRegex,
  ].some((rule) => rule !== "");
  if (!anySelector) policy.unencryptedSuffix = DEFAULT_POLICY.unencryptedSuffix;
  const thresholdText = textOf(entry(node, "shamir_threshold"));
  const shamirThreshold = thresholdText === "" ? 0 : Number(thresholdText);
  if (!Number.isInteger(shamirThreshold) || shamirThreshold < 0)
    throw refuse("shamir_threshold is not a count.");
  return {
    pathRegex: textOf(entry(node, "path_regex")),
    groups,
    shamirThreshold,
    policy,
    unsupported,
  };
}

/** Parse an explicitly supplied `.sops.yaml`. */
export function parseSopsConfig(text: string): SopsConfig {
  if (text.length > MAX_CONFIG_BYTES)
    throw new SopsError(
      "resource_limit",
      "The config exceeds its size budget.",
    );
  const docs = parseYamlDocuments(text);
  const root = docs[0];
  if (!root || docs.length !== 1)
    throw refuse("A config is one YAML document.");
  for (const field of entries(root)) {
    if (field.key === "creation_rules") continue;
    if (field.key === "stores") continue;
    // destination_rules publish to S3/GCS/Vault; never honored here.
    throw refuse(
      "The config carries a top-level key this engine does not honor.",
    );
  }
  const rulesNode = entry(root, "creation_rules");
  if (rulesNode === undefined || rulesNode.kind !== "seq")
    throw refuse("creation_rules must be a list.");
  if (rulesNode.items.length > MAX_CONFIG_RULES)
    throw new SopsError("resource_limit", "Too many creation rules.");
  const rules = rulesNode.items.map((item) => {
    if (item.kind === "comment")
      throw refuse("creation_rules holds a comment.");
    return ruleOf(item);
  });
  for (const rule of rules)
    if (rule.pathRegex !== "") matchRe2(rule.pathRegex, "");
  return { rules };
}

/**
 * Upstream `parseCreationRuleForFile`: the document path relative to the
 * config's directory, first match wins. `documentPath` and `configDir` are
 * logical, forward-slash paths the person chose; nothing is read from disk.
 */
export function selectCreationRule(
  config: SopsConfig,
  documentPath: string,
  configDir = "",
): CreationRule {
  const dir = configDir.replace(/\/+$/u, "");
  const relative =
    dir !== "" && documentPath.startsWith(`${dir}/`)
      ? documentPath.slice(dir.length + 1)
      : documentPath;
  for (const rule of config.rules) {
    if (rule.pathRegex === "" || matchRe2(rule.pathRegex, relative))
      return rule;
  }
  throw refuse("No creation rule matches the document path.");
}

/** Turn a selected rule into a plan the person can review and approve. */
export function planFromRule(
  rule: CreationRule,
  format: "yaml" | "json",
): EncryptionPlan {
  if (rule.unsupported.length > 0) {
    throw new SopsError(
      "unsupported_feature",
      "The rule names master key types this browser cannot wrap.",
    );
  }
  const plan: EncryptionPlan = {
    format,
    groups: rule.groups,
    shamirThreshold: rule.shamirThreshold,
    policy: rule.policy,
  };
  validatePlan(plan);
  return plan;
}
