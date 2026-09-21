import type { SopsEntry, SopsNode, SopsPolicy } from "./tree.js";

export type AgeKey = { recipient: string; enc: string };

export type SopsMetadataInput = {
  groups: AgeKey[][];
  shamirThreshold: number;
  mac: string;
  lastModified: string;
  policy: SopsPolicy;
};

function ageSeq(keys: AgeKey[]): SopsNode {
  return {
    kind: "seq",
    items: keys.map((key) => ({
      kind: "map",
      entries: [
        {
          key: "recipient",
          value: {
            kind: "scalar",
            scalar: { kind: "str", value: key.recipient },
          },
        },
        {
          key: "enc",
          value: { kind: "scalar", scalar: { kind: "str", value: key.enc } },
        },
      ],
    })),
  };
}

export function metadataNode(input: SopsMetadataInput): SopsNode {
  const entries: SopsEntry[] = [];
  if (input.groups.length <= 1) {
    entries.push({ key: "age", value: ageSeq(input.groups[0] ?? []) });
  } else {
    entries.push({
      key: "shamir_threshold",
      value: {
        kind: "scalar",
        scalar: { kind: "int", value: String(input.shamirThreshold) },
      },
    });
    entries.push({
      key: "key_groups",
      value: {
        kind: "seq",
        items: input.groups.map((group) => ({
          kind: "map",
          entries: [{ key: "age", value: ageSeq(group) }],
        })),
      },
    });
  }
  entries.push(
    {
      key: "lastmodified",
      value: {
        kind: "scalar",
        scalar: { kind: "str", value: input.lastModified },
      },
    },
    {
      key: "mac",
      value: { kind: "scalar", scalar: { kind: "str", value: input.mac } },
    },
    {
      key: "unencrypted_suffix",
      value: {
        kind: "scalar",
        scalar: { kind: "str", value: input.policy.unencryptedSuffix },
      },
    },
    {
      key: "version",
      value: { kind: "scalar", scalar: { kind: "str", value: "3.13.3" } },
    },
  );
  if (input.policy.macOnlyEncrypted) {
    entries.push({
      key: "mac_only_encrypted",
      value: { kind: "scalar", scalar: { kind: "bool", value: true } },
    });
  }
  return { kind: "map", entries };
}
