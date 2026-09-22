/**
 * The ordered tree walk of getsops/sops `sops.go` (26e2f478): `walkBranch`,
 * `walkSlice`, `Tree.Encrypt` and `Tree.Decrypt`, with the comments stack,
 * the `path:` associated data (no sequence indices), the SHA-512 MAC over
 * `ToBytes` of every non-comment leaf, and the `mac_only_encrypted` domain
 * marker (the SHA-256 of `sops`).
 */

import {
  decryptRecord,
  encryptPlain,
  isEmptyPlain,
  isEncryptedRecord,
} from "./aes-record.js";
import { SopsError } from "./errors.js";
import type {
  SopsComment,
  SopsMapItem,
  SopsNode,
  SopsSeqItem,
} from "./model.js";
import { type SopsPlain, type SopsScalar, plainToBytes } from "./scalars.js";
import { type SopsPolicy, matchRe2, shouldBeEncrypted } from "./selectors.js";

export const MAC_ONLY_ENCRYPTED_INITIALIZATION = Uint8Array.from([
  0x8a, 0x3f, 0xd2, 0xad, 0x54, 0xce, 0x66, 0x52, 0x7b, 0x10, 0x34, 0xf3, 0xd1,
  0x47, 0xbe, 0x0b, 0x0b, 0x97, 0x5b, 0x3b, 0xf4, 0x4f, 0x72, 0xc6, 0xfd, 0xad,
  0xec, 0x81, 0x76, 0xf2, 0x7d, 0x69,
]);

type Stack = string[][];

type OnLeaf = (
  plain: SopsPlain,
  path: readonly string[],
  stack: Stack,
) => SopsPlain;

export function pathAad(path: readonly string[]): string {
  return `${path.join(":")}:`;
}

function scalarOf(plain: SopsPlain): SopsScalar {
  if (plain.kind === "comment") {
    throw new SopsError(
      "unsupported_feature",
      "A mapping value decrypted to a comment; only sequences carry comment items.",
    );
  }
  return plain;
}

function walkValue(
  node: SopsNode,
  path: string[],
  stack: Stack,
  onLeaf: OnLeaf,
): SopsNode {
  switch (node.kind) {
    case "null":
      return node;
    case "scalar":
      return {
        kind: "scalar",
        scalar: scalarOf(onLeaf(node.scalar, path, stack)),
      };
    case "map":
      return {
        kind: "map",
        items: walkBranch(node.items, path, stack, onLeaf),
      };
    case "seq":
      return { kind: "seq", items: walkSlice(node.items, path, stack, onLeaf) };
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

function commentFrom(plain: SopsPlain, inline: boolean): SopsComment {
  if (plain.kind === "comment" || plain.kind === "str") {
    return { kind: "comment", value: plain.value, inline };
  }
  throw new SopsError(
    "malformed_encoding",
    "A comment did not walk to a comment.",
  );
}

function walkSlice(
  items: SopsSeqItem[],
  path: string[],
  stack: Stack,
  onLeaf: OnLeaf,
): SopsSeqItem[] {
  const level: string[] = [];
  const nextStack = [...stack, level];
  const out: SopsSeqItem[] = [];
  for (const item of items) {
    if (item.kind === "comment") {
      level.push(item.value);
      out.push(
        commentFrom(
          onLeaf({ kind: "comment", value: item.value }, path, nextStack),
          item.inline,
        ),
      );
      continue;
    }
    if (item.kind === "scalar") {
      const plain = onLeaf(item.scalar, path, nextStack);
      // Upstream: a string leaf may decrypt into a comment inside a slice.
      out.push(
        plain.kind === "comment"
          ? { kind: "comment", value: plain.value, inline: false }
          : { kind: "scalar", scalar: plain },
      );
    } else {
      out.push(walkValue(item, path, nextStack, onLeaf));
    }
    level.length = 0;
  }
  return out;
}

function walkBranch(
  items: SopsMapItem[],
  path: string[],
  stack: Stack,
  onLeaf: OnLeaf,
): SopsMapItem[] {
  const level: string[] = [];
  const nextStack = [...stack, level];
  const out: SopsMapItem[] = [];
  for (const item of items) {
    if (item.kind === "comment") {
      level.push(item.value);
      out.push(
        commentFrom(
          onLeaf({ kind: "comment", value: item.value }, path, nextStack),
          item.inline,
        ),
      );
      continue;
    }
    out.push({
      kind: "entry",
      key: item.key,
      value: walkValue(item.value, [...path, item.key], nextStack, onLeaf),
    });
    level.length = 0;
  }
  return out;
}

async function sha512Hex(chunks: readonly Uint8Array[]): Promise<string> {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", joined));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export type WalkResult = { roots: SopsNode[]; macHex: string };

function walkRoots(roots: readonly SopsNode[], onLeaf: OnLeaf): SopsNode[] {
  return roots.map((root) => {
    if (root.kind !== "map") {
      throw new SopsError(
        "invalid_document",
        "Every SOPS document is a mapping.",
      );
    }
    return { kind: "map", items: walkBranch(root.items, [], [], onLeaf) };
  });
}

/** `Tree.Encrypt`: encrypt selected leaves, hash every non-comment leaf. */
export async function encryptTree(
  roots: readonly SopsNode[],
  key: Uint8Array,
  policy: SopsPolicy,
): Promise<WalkResult> {
  const mac: Uint8Array[] = policy.macOnlyEncrypted
    ? [MAC_ONLY_ENCRYPTED_INITIALIZATION]
    : [];
  const next = walkRoots(roots, (plain, path, stack) => {
    const isComment = plain.kind === "comment";
    const encrypted = shouldBeEncrypted(policy, path, stack, isComment);
    if ((!policy.macOnlyEncrypted || encrypted) && !isComment)
      mac.push(plainToBytes(plain));
    if (!encrypted) return plain;
    const sealed = encryptPlain(plain, key, pathAad(path));
    if (
      isComment &&
      policy.unencryptedCommentRegex !== "" &&
      matchRe2(policy.unencryptedCommentRegex, sealed)
    ) {
      throw new SopsError(
        "unauthorized_policy",
        "An encrypted comment would match unencrypted_comment_regex.",
      );
    }
    return isComment
      ? { kind: "comment", value: sealed }
      : { kind: "str", value: sealed };
  });
  return { roots: next, macHex: await sha512Hex(mac) };
}

/**
 * `Tree.Decrypt`, with one deliberate strictness: a comment that carries an
 * `ENC[…]` frame must authenticate. Upstream falls back to treating any
 * comment that fails to decrypt as legacy cleartext; here only a comment
 * that never claimed to be encrypted is kept, and it is not authenticated.
 */
export async function decryptTree(
  roots: readonly SopsNode[],
  key: Uint8Array,
  policy: SopsPolicy,
): Promise<WalkResult> {
  const mac: Uint8Array[] = policy.macOnlyEncrypted
    ? [MAC_ONLY_ENCRYPTED_INITIALIZATION]
    : [];
  const next = walkRoots(roots, (plain, path, stack) => {
    const isComment = plain.kind === "comment";
    const encrypted = shouldBeEncrypted(policy, path, stack, isComment);
    let opened: SopsPlain = plain;
    if (encrypted) {
      if (isComment) {
        if (isEncryptedRecord(plain.value)) {
          opened = decryptRecord(plain.value, key, pathAad(path));
          if (opened.kind !== "comment" && opened.kind !== "str") {
            throw new SopsError(
              "malformed_encoding",
              "An encrypted comment has a non-comment type.",
            );
          }
          opened = { kind: "comment", value: opened.value };
        }
      } else if (plain.kind === "str") {
        if (!isEmptyPlain(plain) && !isEncryptedRecord(plain.value)) {
          throw new SopsError(
            "malformed_encoding",
            "A selected value is not an ENC[…] record.",
            path,
          );
        }
        opened = decryptRecord(plain.value, key, pathAad(path));
      } else {
        throw new SopsError(
          "malformed_encoding",
          "A selected value is not an encrypted string.",
          path,
        );
      }
    }
    if ((!policy.macOnlyEncrypted || encrypted) && opened.kind !== "comment") {
      mac.push(plainToBytes(opened));
    }
    return opened;
  });
  return { roots: next, macHex: await sha512Hex(mac) };
}

/** Upstream MAC handling in `cmd/sops/common`: sealed under `lastmodified`. */
export function encryptMac(
  macHex: string,
  key: Uint8Array,
  lastModified: string,
): string {
  return encryptPlain({ kind: "str", value: macHex }, key, lastModified);
}

export function decryptMac(
  record: string,
  key: Uint8Array,
  lastModified: string,
): string {
  const plain = decryptRecord(record, key, lastModified);
  if (plain.kind !== "str") {
    throw new SopsError(
      "authentication_failed",
      "The stored MAC is not a string.",
    );
  }
  return plain.value;
}
