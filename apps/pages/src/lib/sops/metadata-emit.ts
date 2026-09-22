/**
 * Writing the `sops` metadata block, as upstream's stores emit it
 * (`stores/stores.go`, `stores/metadata.go` at 26e2f478).
 *
 * Upstream serializes through a Go map, so keys come out sorted,
 * `omitempty` drops empty lists and zero values, and every group in a
 * multi-group file always carries `age` and `hc_vault`.
 */

import {
  MASTER_KEY_KINDS,
  type MasterKeyKind,
  type SopsKeyGroup,
  type SopsMasterKey,
  type SopsMetadata,
} from "./metadata.js";
import {
  type SopsEntry,
  type SopsMap,
  type SopsNode,
  entries,
  map,
  setEntry,
  str,
} from "./model.js";

function sortedMap(node: SopsMap): SopsMap {
  return map(
    [...entries(node)].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    ),
  );
}

function keyListNode(
  kind: MasterKeyKind,
  keys: readonly SopsMasterKey[],
): SopsNode {
  return {
    kind: "seq",
    items: keys
      .filter((key) => key.kind === kind)
      .map((key) =>
        key.kind === "age"
          ? map([
              setEntry("enc", str(key.enc)),
              setEntry("recipient", str(key.recipient)),
            ])
          : sortedMap(key.raw),
      ),
  };
}

function groupEntries(
  group: SopsKeyGroup,
  always: readonly MasterKeyKind[],
): SopsEntry[] {
  const out: SopsEntry[] = [];
  for (const kind of [...MASTER_KEY_KINDS].sort()) {
    const node = keyListNode(kind, group.keys);
    if (
      node.kind === "seq" &&
      (node.items.length > 0 || always.includes(kind))
    ) {
      out.push(setEntry(kind, node));
    }
  }
  return out;
}

/** Serialize with upstream's sorted-key, omitempty layout. */
export function serializeSopsMetadata(meta: SopsMetadata): SopsMap {
  const items: SopsEntry[] = [];
  const policy = meta.policy;
  const groupsOut = meta.groups;
  if (groupsOut.length === 1 && groupsOut[0]) {
    items.push(...groupEntries(groupsOut[0], []));
  } else {
    items.push(
      setEntry("key_groups", {
        kind: "seq",
        items: groupsOut.map((group) =>
          map(groupEntries(group, ["age", "hc_vault"])),
        ),
      }),
    );
  }
  const text = (key: string, value: string): void => {
    if (value !== "") items.push(setEntry(key, str(value)));
  };
  text("encrypted_comment_regex", policy.encryptedCommentRegex);
  text("encrypted_regex", policy.encryptedRegex);
  text("encrypted_suffix", policy.encryptedSuffix);
  items.push(setEntry("lastmodified", str(meta.lastModified)));
  items.push(setEntry("mac", str(meta.mac)));
  if (policy.macOnlyEncrypted) {
    items.push(
      setEntry("mac_only_encrypted", {
        kind: "scalar",
        scalar: { kind: "bool", value: true },
      }),
    );
  }
  if (groupsOut.length > 1 && meta.shamirThreshold > 0) {
    items.push(
      setEntry("shamir_threshold", {
        kind: "scalar",
        scalar: { kind: "int", value: String(meta.shamirThreshold) },
      }),
    );
  }
  text("unencrypted_comment_regex", policy.unencryptedCommentRegex);
  text("unencrypted_regex", policy.unencryptedRegex);
  text("unencrypted_suffix", policy.unencryptedSuffix);
  items.push(setEntry("version", str(meta.version)));
  return sortedMap(map(items));
}

/** The number of groups that must open: upstream's default is every group. */
export function effectiveThreshold(meta: SopsMetadata): number {
  if (meta.groups.length <= 1) return 1;
  return meta.shamirThreshold === 0 ? meta.groups.length : meta.shamirThreshold;
}
