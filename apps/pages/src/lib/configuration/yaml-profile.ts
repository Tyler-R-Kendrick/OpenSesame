import {
  type Document,
  type YAMLMap,
  type YAMLSeq,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
} from "yaml";
import {
  MAX_COLLECTION_ENTRIES,
  MAX_DIAGNOSTICS,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_DEPTH,
} from "./limits.js";
import type { ConfigDiagnostic } from "./types.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type YamlParseOk = {
  ok: true;
  document: Document.Parsed;
  value: Record<string, unknown>;
  diagnostics: ConfigDiagnostic[];
};

export type YamlParseFail = {
  ok: false;
  diagnostics: ConfigDiagnostic[];
  value?: Record<string, unknown>;
};

export type YamlParseResult = YamlParseOk | YamlParseFail;

function tooMany(diagnostics: ConfigDiagnostic[]): ConfigDiagnostic[] {
  if (diagnostics.length <= MAX_DIAGNOSTICS) return diagnostics;
  return [
    ...diagnostics.slice(0, MAX_DIAGNOSTICS),
    {
      severity: "error",
      code: "too_many_diagnostics",
      message: `Stopped after ${MAX_DIAGNOSTICS} diagnostics.`,
    },
  ];
}

function pushError(
  diagnostics: ConfigDiagnostic[],
  code: string,
  message: string,
): void {
  if (diagnostics.length > MAX_DIAGNOSTICS) return;
  diagnostics.push({ severity: "error", code, message });
}

function isMultiDocument(source: string): boolean {
  const trimmed = source.trimStart();
  if (trimmed.startsWith("---") && trimmed.includes("\n---")) return true;
  return /\n---\s*\n/.test(source);
}

function countEntries(node: unknown, depth: number): number {
  if (depth > MAX_DOCUMENT_DEPTH) return MAX_COLLECTION_ENTRIES + 1;
  if (isMap(node)) {
    const map = node as YAMLMap;
    let total = map.items.length;
    for (const item of map.items) {
      total += countEntries(item.value, depth + 1);
    }
    return total;
  }
  if (isSeq(node)) {
    const seq = node as YAMLSeq;
    let total = seq.items.length;
    for (const item of seq.items) total += countEntries(item, depth + 1);
    return total;
  }
  return 0;
}

function jsonValue(node: unknown, diagnostics: ConfigDiagnostic[]): unknown {
  if (node === null || node === undefined) return null;
  if (isAlias(node)) {
    pushError(
      diagnostics,
      "alias_forbidden",
      "YAML aliases and anchors are not supported.",
    );
    return null;
  }
  if (isScalar(node)) return node.value;
  if (isMap(node)) {
    const record: Record<string, unknown> = Object.create(null);
    for (const item of (node as YAMLMap).items) {
      if (!isScalar(item.key) || typeof item.key.value !== "string") {
        pushError(
          diagnostics,
          "non_string_key",
          "Mapping keys must be strings.",
        );
        continue;
      }
      const key = item.key.value;
      if (DANGEROUS_KEYS.has(key)) {
        pushError(diagnostics, "dangerous_key", `Key "${key}" is not allowed.`);
        continue;
      }
      record[key] = jsonValue(item.value, diagnostics);
    }
    return record;
  }
  if (isSeq(node)) {
    return (node as YAMLSeq).items.map((item) => jsonValue(item, diagnostics));
  }
  return null;
}

/**
 * Parse a YAML 1.2 JSON-compatible mapping. Original source is preserved by
 * the caller; this never fetches, never evaluates tags, and never follows
 * aliases.
 */
export function parseConfigYaml(source: string): YamlParseResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const bytes = new TextEncoder().encode(source).byteLength;
  if (bytes > MAX_DOCUMENT_BYTES) {
    pushError(
      diagnostics,
      "too_large",
      `Document exceeds ${MAX_DOCUMENT_BYTES} bytes.`,
    );
    return { ok: false, diagnostics: tooMany(diagnostics) };
  }
  if (isMultiDocument(source)) {
    pushError(
      diagnostics,
      "multi_document",
      "Multi-document YAML streams are not supported.",
    );
    return { ok: false, diagnostics: tooMany(diagnostics) };
  }

  const document = parseDocument(source, {
    prettyErrors: true,
    uniqueKeys: true,
    schema: "core",
    logLevel: "silent",
    strict: true,
    merge: false,
  });

  for (const error of document.errors) {
    pushError(diagnostics, "yaml_error", error.message);
  }

  visit(document, {
    Pair(_, pair) {
      const tagged = pair.value;
      const tag =
        tagged && typeof tagged === "object" && "tag" in tagged
          ? tagged.tag
          : undefined;
      if (
        typeof tag === "string" &&
        tag !== "!" &&
        !tag.startsWith("tag:yaml.org,2002:")
      ) {
        pushError(
          diagnostics,
          "custom_tag",
          `Custom YAML tag "${tag}" is not supported.`,
        );
      }
      if (isScalar(pair.key) && pair.key.value === "<<") {
        pushError(
          diagnostics,
          "merge_key",
          "YAML merge keys are not supported.",
        );
      }
    },
  });

  if (
    document.contents &&
    countEntries(document.contents, 0) > MAX_COLLECTION_ENTRIES
  ) {
    pushError(
      diagnostics,
      "too_many_entries",
      `Collections exceed ${MAX_COLLECTION_ENTRIES} entries.`,
    );
  }

  const hasError = diagnostics.some((item) => item.severity === "error");
  if (!isMap(document.contents) && document.contents !== null) {
    pushError(
      diagnostics,
      "root_not_map",
      "The document root must be a mapping.",
    );
    return { ok: false, diagnostics: tooMany(diagnostics) };
  }

  const value = jsonValue(document.contents, diagnostics);
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const failed =
    hasError || diagnostics.some((item) => item.severity === "error");
  if (failed) {
    return { ok: false, diagnostics: tooMany(diagnostics), value: record };
  }
  return {
    ok: true,
    document,
    value: record,
    diagnostics: tooMany(diagnostics),
  };
}
