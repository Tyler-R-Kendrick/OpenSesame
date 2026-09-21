/**
 * Browser SOPS YAML/JSON with local age identities.
 * No Host, no `sops` binary, no `OPENSESAME_SOPS_BIN`.
 * Profile: v3.13.3 age envelopes, single-group any-of and multi-group Shamir.
 */

import * as age from "age-encryption";
import { isAgeIdentity, isAgeRecipient } from "../age-keys.js";
import { emitJsonTree, parseJsonTree } from "./json-codec.js";
import { type AgeKey, metadataNode } from "./metadata.js";
import { shamirCombine, shamirSplit } from "./shamir.js";
import {
  DEFAULT_POLICY,
  type SopsNode,
  type SopsPolicy,
  decryptMac,
  decryptTree,
  encryptMac,
  encryptTree,
  rfc3339Utc,
} from "./tree.js";
import { emitYamlTree, parseYamlDocuments } from "./yaml-codec.js";

export const SOPS_PROFILE = "sops-browser/v3.13.3-age";

export type SopsFormat = "yaml" | "json";

type Loaded = {
  branches: SopsNode[];
  ageKeys: AgeKey[];
  groups: AgeKey[][];
  shamirThreshold: number;
  policy: SopsPolicy;
  mac: string;
  lastModified: string;
  version: string;
};

function asMap(node: SopsNode): SopsNode & { kind: "map" } {
  if (node.kind !== "map") throw new Error("SOPS document must be a mapping");
  return node;
}

function entry(node: SopsNode, key: string): SopsNode | undefined {
  if (node.kind !== "map") return undefined;
  return node.entries.find((item) => item.key === key)?.value;
}

function str(node: SopsNode | undefined): string {
  if (!node || node.kind !== "scalar" || node.scalar.kind !== "str") return "";
  return node.scalar.value;
}

function ageList(node: SopsNode | undefined): AgeKey[] {
  if (!node || node.kind !== "seq") return [];
  const keys: AgeKey[] = [];
  for (const item of node.items) {
    const recipient = str(entry(item, "recipient")).trim();
    const enc = str(entry(item, "enc")).trim();
    if (!recipient || !enc) continue;
    keys.push({ recipient, enc });
  }
  return keys;
}

function withoutSops(node: SopsNode): SopsNode {
  const map = asMap(node);
  return {
    kind: "map",
    entries: map.entries.filter((item) => item.key !== "sops"),
  };
}

function load(text: string, format: SopsFormat): Loaded {
  const roots =
    format === "json" ? [parseJsonTree(text)] : parseYamlDocuments(text);
  const root = roots.find((node) => entry(node, "sops"));
  const sops = root ? entry(root, "sops") : undefined;
  if (!sops) throw new Error("document has no sops metadata");
  const flat = ageList(entry(sops, "age"));
  const groupsNode = entry(sops, "key_groups");
  const groups =
    groupsNode && groupsNode.kind === "seq"
      ? groupsNode.items.map((group) => ageList(entry(group, "age")))
      : flat.length > 0
        ? [flat]
        : [];
  const thresholdRaw = entry(sops, "shamir_threshold");
  const shamirThreshold =
    thresholdRaw &&
    thresholdRaw.kind === "scalar" &&
    thresholdRaw.scalar.kind === "int"
      ? Number(thresholdRaw.scalar.value)
      : 0;
  const suffix = str(entry(sops, "unencrypted_suffix"));
  const encryptedSuffix = str(entry(sops, "encrypted_suffix"));
  const macOnly = entry(sops, "mac_only_encrypted");
  return {
    branches: roots.map(withoutSops),
    ageKeys: flat,
    groups,
    shamirThreshold,
    policy: {
      unencryptedSuffix: suffix || DEFAULT_POLICY.unencryptedSuffix,
      encryptedSuffix,
      unencryptedRegex: str(entry(sops, "unencrypted_regex")),
      encryptedRegex: str(entry(sops, "encrypted_regex")),
      unencryptedCommentRegex: str(entry(sops, "unencrypted_comment_regex")),
      encryptedCommentRegex: str(entry(sops, "encrypted_comment_regex")),
      macOnlyEncrypted:
        macOnly?.kind === "scalar" &&
        macOnly.scalar.kind === "bool" &&
        macOnly.scalar.value,
    },
    mac: str(entry(sops, "mac")),
    lastModified: str(entry(sops, "lastmodified")),
    version: str(entry(sops, "version")),
  };
}

async function wrapAge(
  payload: Uint8Array,
  recipient: string,
): Promise<string> {
  if (!isAgeRecipient(recipient)) throw new Error("invalid age recipient");
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  const ciphertext = await encrypter.encrypt(payload);
  const armored = age.armor.encode(ciphertext);
  return armored.endsWith("\n") ? armored : `${armored}\n`;
}

async function unwrapAge(
  enc: string,
  identity: string,
): Promise<Uint8Array | null> {
  if (!isAgeIdentity(identity)) return null;
  try {
    const decoded = age.armor.decode(enc);
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(identity);
    return await decrypter.decrypt(decoded, "uint8array");
  } catch {
    return null;
  }
}

async function recoverKey(
  loaded: Loaded,
  identities: readonly string[],
): Promise<Uint8Array> {
  const groups = loaded.groups.length > 0 ? loaded.groups : [loaded.ageKeys];
  const shares: Uint8Array[] = [];
  for (const group of groups) {
    let opened: Uint8Array | null = null;
    for (const wrapped of group) {
      for (const identity of identities) {
        opened = await unwrapAge(wrapped.enc, identity);
        if (opened) break;
      }
      if (opened) break;
    }
    if (opened) shares.push(opened);
  }
  if (groups.length <= 1) {
    const only = shares[0];
    if (!only || only.byteLength !== 32)
      throw new Error("no matching age identity");
    return only;
  }
  const threshold = loaded.shamirThreshold || groups.length;
  if (shares.length < threshold) throw new Error("insufficient key groups");
  const secret = shamirCombine(shares.slice(0, threshold));
  if (secret.byteLength !== 32)
    throw new Error("recovered data key has the wrong length");
  return secret;
}

function attachSops(branch: SopsNode, sops: SopsNode): SopsNode {
  const map = asMap(branch);
  return {
    kind: "map",
    entries: [...map.entries, { key: "sops", value: sops }],
  };
}

function emit(node: SopsNode, format: SopsFormat): string {
  return format === "json" ? `${emitJsonTree(node)}\n` : emitYamlTree(node);
}

export async function encryptSopsDocument(input: {
  format: SopsFormat;
  plaintext: string;
  recipients: readonly string[];
  groups?: readonly (readonly string[])[];
  threshold?: number;
  now?: Date;
  policy?: SopsPolicy;
}): Promise<string> {
  const listed =
    input.groups && input.groups.length > 0
      ? input.groups.map((group) => [
          ...new Set(group.map((line) => line.trim()).filter(Boolean)),
        ])
      : [
          [
            ...new Set(
              input.recipients.map((line) => line.trim()).filter(Boolean),
            ),
          ],
        ];
  if (listed.length === 0 || listed.some((group) => group.length === 0)) {
    throw new Error("SOPS needs at least one age recipient");
  }
  for (const group of listed) {
    for (const recipient of group) {
      if (!isAgeRecipient(recipient)) throw new Error("invalid age recipient");
    }
  }
  const threshold =
    listed.length === 1 ? 1 : (input.threshold ?? listed.length);
  if (listed.length > 1 && (threshold < 2 || threshold > listed.length)) {
    throw new Error("invalid shamir threshold");
  }
  const roots =
    input.format === "json"
      ? [parseJsonTree(input.plaintext)]
      : parseYamlDocuments(input.plaintext);
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  try {
    const policy = input.policy ?? DEFAULT_POLICY;
    const encrypted = await encryptTree(roots, key, policy);
    const lastModified = rfc3339Utc(input.now ?? new Date());
    const mac = encryptMac(encrypted.macHex, key, lastModified);
    const shares =
      listed.length === 1 ? [key] : shamirSplit(key, listed.length, threshold);
    const groups: AgeKey[][] = [];
    for (let index = 0; index < listed.length; index += 1) {
      const share = shares[index];
      const recipients = listed[index];
      if (!share || !recipients) throw new Error("missing shamir share");
      const wrapped: AgeKey[] = [];
      for (const recipient of recipients) {
        wrapped.push({ recipient, enc: await wrapAge(share, recipient) });
      }
      groups.push(wrapped);
    }
    const branch = encrypted.branches[0];
    if (!branch) throw new Error("empty document");
    const withMeta = attachSops(
      branch,
      metadataNode({
        groups,
        shamirThreshold: threshold,
        mac,
        lastModified,
        policy,
      }),
    );
    const published = encrypted.branches.map((item, index) =>
      index === 0 ? withMeta : item,
    );
    if (input.format === "json") return emit(withMeta, "json");
    return published.map((item) => emitYamlTree(item)).join("---\n");
  } finally {
    key.fill(0);
  }
}

export async function decryptSopsDocument(input: {
  format: SopsFormat;
  ciphertext: string;
  identity: string;
  identities?: readonly string[];
}): Promise<string> {
  const loaded = load(input.ciphertext, input.format);
  const identities = input.identities ?? [input.identity];
  const key = await recoverKey(loaded, identities);
  try {
    const opened = await decryptTree(loaded.branches, key, loaded.policy);
    const mac = decryptMac(loaded.mac, key, loaded.lastModified);
    if (mac !== opened.macHex) throw new Error("SOPS MAC mismatch");
    const branch = opened.branches[0];
    if (!branch) throw new Error("empty document");
    if (input.format === "json") return emit(branch, "json");
    return opened.branches.map((item) => emitYamlTree(item)).join("---\n");
  } finally {
    key.fill(0);
  }
}

export type SopsInspection = {
  encrypted: boolean;
  version: string;
  recipients: number;
  groups: number;
};

export function inspectSopsDocument(
  text: string,
  format: SopsFormat,
): SopsInspection {
  const loaded = load(text, format);
  return {
    encrypted: loaded.mac.startsWith("ENC["),
    version: loaded.version,
    recipients:
      loaded.ageKeys.length || loaded.groups.reduce((n, g) => n + g.length, 0),
    groups: loaded.groups.length,
  };
}

export { shamirSplit };
