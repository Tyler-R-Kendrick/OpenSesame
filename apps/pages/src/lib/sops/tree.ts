/**
 * Ordered SOPS tree. MAC and path AAD follow getsops/sops `sops.go`
 * Encrypt/Decrypt at 26e2f478 (v3.13.3).
 */

import {
  type SopsScalar,
  decryptRecord,
  encryptScalar,
  isEncryptedRecord,
  scalarToBytes,
} from "./aes-record.js";
import { matchRe2 } from "./selectors.js";

export type SopsEntry = {
  key: string;
  value: SopsNode;
  comments?: readonly string[];
};

export type SopsNode =
  | { kind: "null" }
  | { kind: "scalar"; scalar: SopsScalar }
  | { kind: "seq"; items: SopsNode[] }
  | { kind: "map"; entries: SopsEntry[] };

export type SopsPolicy = {
  unencryptedSuffix: string;
  encryptedSuffix: string;
  unencryptedRegex: string;
  encryptedRegex: string;
  unencryptedCommentRegex: string;
  encryptedCommentRegex: string;
  macOnlyEncrypted: boolean;
};

export const DEFAULT_POLICY: SopsPolicy = {
  unencryptedSuffix: "_unencrypted",
  encryptedSuffix: "",
  unencryptedRegex: "",
  encryptedRegex: "",
  unencryptedCommentRegex: "",
  encryptedCommentRegex: "",
  macOnlyEncrypted: false,
};

const MAC_ONLY_INIT = Uint8Array.from([
  0x8a, 0x3f, 0xd2, 0xad, 0x54, 0xce, 0x66, 0x52, 0x7b, 0x10, 0x34, 0xf3, 0xd1,
  0x47, 0xbe, 0x0b, 0x0b, 0x97, 0x5b, 0x3b, 0xf4, 0x4f, 0x72, 0xc6, 0xfd, 0xad,
  0xec, 0x81, 0x76, 0xf2, 0x7d, 0x69,
]);

function segmentMatches(pattern: string, path: readonly string[]): boolean {
  if (pattern === "") return false;
  for (const segment of path) {
    if (matchRe2(pattern, segment)) return true;
  }
  return false;
}

function commentMatches(
  pattern: string,
  comments: readonly string[],
  skipLast: boolean,
): boolean {
  if (pattern === "") return false;
  const limit = skipLast ? comments.length - 1 : comments.length;
  for (let index = 0; index < limit; index += 1) {
    const comment = comments[index];
    if (comment !== undefined && matchRe2(pattern, comment)) return true;
  }
  return false;
}

export function shouldEncrypt(
  path: readonly string[],
  policy: SopsPolicy,
  comments: readonly string[] = [],
  isComment = false,
): boolean {
  let encrypted = true;
  if (policy.unencryptedSuffix !== "") {
    for (const segment of path) {
      if (segment.endsWith(policy.unencryptedSuffix)) encrypted = false;
    }
  }
  if (policy.encryptedSuffix !== "") {
    encrypted = false;
    for (const segment of path) {
      if (segment.endsWith(policy.encryptedSuffix)) encrypted = true;
    }
  }
  if (segmentMatches(policy.unencryptedRegex, path)) encrypted = false;
  if (policy.encryptedRegex !== "") {
    encrypted = segmentMatches(policy.encryptedRegex, path);
  }
  if (commentMatches(policy.unencryptedCommentRegex, comments, false)) {
    encrypted = false;
  }
  if (policy.encryptedCommentRegex !== "") {
    encrypted = commentMatches(
      policy.encryptedCommentRegex,
      comments,
      isComment,
    );
  }
  return encrypted;
}

async function sha512(chunks: readonly Uint8Array[]): Promise<Uint8Array> {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-512", joined);
  return new Uint8Array(digest);
}

function hexUpper(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function pathAad(path: readonly string[]): string {
  return `${path.join(":")}:`;
}

function rewriteComments(
  comments: readonly string[] | undefined,
  path: readonly string[],
  key: Uint8Array,
  policy: SopsPolicy,
  decrypt: boolean,
): readonly string[] | undefined {
  if (!comments || comments.length === 0) return comments;
  return comments.map((comment, index) => {
    const prior = comments.slice(0, index + 1);
    const selected = shouldEncrypt(path, policy, prior, true);
    if (!selected) {
      if (decrypt && isEncryptedRecord(comment)) {
        throw new Error("encrypted comment failed its selector");
      }
      return comment;
    }
    if (!decrypt) {
      return encryptScalar(
        { kind: "comment", value: comment },
        key,
        pathAad(path),
      );
    }
    if (!isEncryptedRecord(comment)) {
      throw new Error("expected an encrypted SOPS comment");
    }
    const scalar = decryptRecord(comment, key, pathAad(path));
    if (scalar.kind !== "comment" && scalar.kind !== "str") {
      throw new Error("encrypted comment has the wrong type");
    }
    return scalar.value;
  });
}

function walkEncrypt(
  node: SopsNode,
  path: string[],
  key: Uint8Array,
  policy: SopsPolicy,
  mac: Uint8Array[],
  comments: readonly string[] = [],
): SopsNode {
  if (node.kind === "null") return node;
  if (node.kind === "seq") {
    return {
      kind: "seq",
      items: node.items.map((item) =>
        walkEncrypt(item, path, key, policy, mac, comments),
      ),
    };
  }
  if (node.kind === "map") {
    return {
      kind: "map",
      entries: node.entries.map((entry) => {
        const nextPath = [...path, entry.key];
        const stack = entry.comments ?? comments;
        const value = walkEncrypt(
          entry.value,
          nextPath,
          key,
          policy,
          mac,
          stack,
        );
        const next: SopsEntry = { key: entry.key, value };
        const nextComments = rewriteComments(
          entry.comments,
          nextPath,
          key,
          policy,
          false,
        );
        if (nextComments && nextComments.length > 0)
          next.comments = nextComments;
        return next;
      }),
    };
  }
  const encrypted = shouldEncrypt(path, policy, comments, false);
  if (!policy.macOnlyEncrypted || encrypted) {
    if (node.scalar.kind !== "comment") mac.push(scalarToBytes(node.scalar));
  }
  if (!encrypted) return node;
  return {
    kind: "scalar",
    scalar: {
      kind: "str",
      value: encryptScalar(node.scalar, key, pathAad(path)),
    },
  };
}

function walkDecrypt(
  node: SopsNode,
  path: string[],
  key: Uint8Array,
  policy: SopsPolicy,
  mac: Uint8Array[],
  comments: readonly string[] = [],
): SopsNode {
  if (node.kind === "null") return node;
  if (node.kind === "seq") {
    return {
      kind: "seq",
      items: node.items.map((item) =>
        walkDecrypt(item, path, key, policy, mac, comments),
      ),
    };
  }
  if (node.kind === "map") {
    return {
      kind: "map",
      entries: node.entries.map((entry) => {
        const nextPath = [...path, entry.key];
        const stack = entry.comments ?? comments;
        const value = walkDecrypt(
          entry.value,
          nextPath,
          key,
          policy,
          mac,
          stack,
        );
        const next: SopsEntry = { key: entry.key, value };
        const nextComments = rewriteComments(
          entry.comments,
          nextPath,
          key,
          policy,
          true,
        );
        if (nextComments && nextComments.length > 0)
          next.comments = nextComments;
        return next;
      }),
    };
  }
  const encrypted = shouldEncrypt(path, policy, comments, false);
  let scalar = node.scalar;
  if (encrypted) {
    if (scalar.kind === "str" && scalar.value === "") {
      scalar = { kind: "str", value: "" };
    } else if (scalar.kind !== "str" || !isEncryptedRecord(scalar.value)) {
      throw new Error("expected an encrypted SOPS value");
    } else {
      scalar = decryptRecord(scalar.value, key, pathAad(path));
    }
  }
  if (!policy.macOnlyEncrypted || encrypted) {
    if (scalar.kind !== "comment") mac.push(scalarToBytes(scalar));
  }
  return { kind: "scalar", scalar };
}

export type SopsTreeMac = {
  branches: SopsNode[];
  macHex: string;
};

export async function encryptTree(
  branches: readonly SopsNode[],
  key: Uint8Array,
  policy: SopsPolicy,
): Promise<SopsTreeMac> {
  const mac: Uint8Array[] = [];
  if (policy.macOnlyEncrypted) mac.push(MAC_ONLY_INIT);
  const next = branches.map((branch) =>
    walkEncrypt(branch, [], key, policy, mac),
  );
  return { branches: next, macHex: hexUpper(await sha512(mac)) };
}

export async function decryptTree(
  branches: readonly SopsNode[],
  key: Uint8Array,
  policy: SopsPolicy,
): Promise<SopsTreeMac> {
  const mac: Uint8Array[] = [];
  if (policy.macOnlyEncrypted) mac.push(MAC_ONLY_INIT);
  const next = branches.map((branch) =>
    walkDecrypt(branch, [], key, policy, mac),
  );
  return { branches: next, macHex: hexUpper(await sha512(mac)) };
}

export function encryptMac(
  macHex: string,
  key: Uint8Array,
  lastModified: string,
): string {
  return encryptScalar({ kind: "str", value: macHex }, key, lastModified);
}

export function decryptMac(
  record: string,
  key: Uint8Array,
  lastModified: string,
): string {
  const scalar = decryptRecord(record, key, lastModified);
  if (scalar.kind !== "str") throw new Error("sops MAC is not a string");
  return scalar.value;
}

export function rfc3339Utc(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/u, "Z");
}
