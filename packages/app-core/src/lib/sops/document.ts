/**
 * Loading and emitting whole SOPS files: the ordered trees of every
 * document plus the one `sops` block, the way upstream's stores extract
 * and serialize it (`stores/metadata.go`, 26e2f478). Upstream parses the
 * block from the first document and silently drops any `sops` key found
 * later in the stream; this engine requires later blocks to be identical
 * and refuses a `sops` key that would collide with data (SB-017).
 */

import { SopsError } from "./errors.js";
import { emitJsonTree, parseJsonTree } from "./json-codec.js";
import { serializeSopsMetadata } from "./metadata-emit.js";
import { type SopsMetadata, parseSopsMetadata } from "./metadata.js";
import {
  type SopsMap,
  type SopsNode,
  entry,
  map,
  nodeEquals,
  setEntry,
  withoutEntry,
} from "./model.js";
import { emitYamlStream } from "./yaml-emit.js";
import { parseYamlDocuments } from "./yaml-parse.js";

export type SopsFormat = "yaml" | "json";

export type LoadedFile = {
  format: SopsFormat;
  /** Data trees with the `sops` block removed. */
  roots: SopsMap[];
  /** Null for a plaintext document (no `sops` block). */
  metadata: SopsMetadata | null;
};

function asMaps(roots: readonly SopsNode[]): SopsMap[] {
  return roots.map((root) => {
    if (root.kind !== "map") {
      throw new SopsError(
        "invalid_document",
        "Every SOPS document is a mapping.",
      );
    }
    return root;
  });
}

export function parseDocuments(text: string, format: SopsFormat): SopsMap[] {
  return asMaps(
    format === "json" ? [parseJsonTree(text)] : parseYamlDocuments(text),
  );
}

/** Parse a file and split off its metadata without touching any key. */
export function loadFile(text: string, format: SopsFormat): LoadedFile {
  const roots = parseDocuments(text, format);
  const first = roots[0];
  if (!first)
    throw new SopsError("invalid_document", "The file holds no document.");
  const block = entry(first, "sops");
  if (block === undefined) {
    for (const root of roots) {
      if (entry(root, "sops") !== undefined) {
        throw new SopsError(
          "invalid_metadata",
          "A later document carries sops metadata but the first does not.",
        );
      }
    }
    return { format, roots, metadata: null };
  }
  for (const root of roots.slice(1)) {
    const other = entry(root, "sops");
    if (other !== undefined && !nodeEquals(other, block)) {
      throw new SopsError(
        "invalid_metadata",
        "Documents in the stream carry conflicting sops metadata.",
      );
    }
  }
  const metadata = parseSopsMetadata(block);
  return {
    format,
    roots: roots.map((root) => withoutEntry(root, "sops")),
    metadata,
  };
}

/** Refuse data that would collide with the reserved metadata key. */
export function assertNoReservedKey(roots: readonly SopsMap[]): void {
  for (const root of roots) {
    if (entry(root, "sops") !== undefined) {
      throw new SopsError(
        "invalid_document",
        "The data already holds a top-level `sops` key.",
      );
    }
  }
}

/** Emit plaintext documents (no metadata). */
export function emitPlain(
  roots: readonly SopsMap[],
  format: SopsFormat,
): string {
  if (format === "json") {
    const only = roots[0];
    if (!only || roots.length !== 1) {
      throw new SopsError(
        "invalid_document",
        "JSON carries exactly one document.",
      );
    }
    return emitJsonTree(only);
  }
  return emitYamlStream(roots);
}

/** Emit encrypted documents with the block appended to each, as upstream does. */
export function emitEncrypted(
  roots: readonly SopsMap[],
  metadata: SopsMetadata,
  format: SopsFormat,
): string {
  const block = serializeSopsMetadata(metadata);
  const withBlock = roots.map((root) =>
    map([...root.items, setEntry("sops", block)]),
  );
  return emitPlain(withBlock, format);
}
