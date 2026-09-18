import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
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
  value: JsonObject;
  diagnostics: ConfigDiagnostic[];
};

export type YamlParseFail = {
  ok: false;
  diagnostics: ConfigDiagnostic[];
  value?: JsonObject;
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

function countEntries(node: BoundaryValue, depth: number): number {
  if (depth > MAX_DOCUMENT_DEPTH) return MAX_COLLECTION_ENTRIES + 1;
  if (isMap(node)) {
    const map: YAMLMap = node;
    let total = map.items.length;
    for (const item of map.items) {
      total += countEntries(overlapCast(item.value), depth + 1);
    }
    return total;
  }
  if (isSeq(node)) {
    const seq: YAMLSeq = node;
    let total = seq.items.length;
    for (const item of seq.items) {
      total += countEntries(overlapCast(item), depth + 1);
    }
    return total;
  }
  return 0;
}

function jsonValue(
  node: BoundaryValue,
  diagnostics: ConfigDiagnostic[],
): JsonValue {
  if (node === null || node === undefined) return null;
  if (isAlias(node)) {
    pushError(
      diagnostics,
      "alias_forbidden",
      "YAML aliases and anchors are not supported.",
    );
    return null;
  }
  if (isScalar(node)) {
    // SAFETY: yaml isScalar established a scalar node with a JSON-compatible value.
    const scalarNode: { value?: BoundaryValue } = overlapCast(node);
    const scalar: JsonValue = overlapCast(scalarNode.value ?? null);
    return scalar;
  }
  if (isMap(node)) {
    const record: JsonObject = Object.create(null);
    const map: YAMLMap = node;
    for (const item of map.items) {
      if (!isScalar(item.key)) {
        pushError(
          diagnostics,
          "non_string_key",
          "Mapping keys must be strings.",
        );
        continue;
      }
      const keyBoundary: BoundaryValue = overlapCast(item.key.value);
      if (!isString(keyBoundary)) {
        pushError(
          diagnostics,
          "non_string_key",
          "Mapping keys must be strings.",
        );
        continue;
      }
      const key = keyBoundary;
      if (DANGEROUS_KEYS.has(key)) {
        pushError(diagnostics, "dangerous_key", `Key "${key}" is not allowed.`);
        continue;
      }
      record[key] = jsonValue(overlapCast(item.value), diagnostics);
    }
    return record;
  }
  if (isSeq(node)) {
    const seq: YAMLSeq = node;
    return seq.items.map((item: BoundaryValue) =>
      jsonValue(overlapCast(item), diagnostics),
    );
  }
  return null;
}

function yamlNodeTag(node: BoundaryValue): string | undefined {
  if (!isTypeofObject(node) || node === null || Array.isArray(node)) {
    return undefined;
  }
  if (!("tag" in node)) return undefined;
  const tag = overlapCast(node).tag;
  return isString(tag) ? tag : undefined;
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
    Pair(_path: string, pair: BoundaryValue) {
      const pairRecord: { key?: BoundaryValue; value?: BoundaryValue } =
        overlapCast(pair);
      const tag = yamlNodeTag(overlapCast(pairRecord.value));
      if (
        tag !== undefined &&
        tag !== "!" &&
        !tag.startsWith("tag:yaml.org,2002:")
      ) {
        pushError(
          diagnostics,
          "custom_tag",
          `Custom YAML tag "${tag}" is not supported.`,
        );
      }
      if (isScalar(pairRecord.key)) {
        // SAFETY: isScalar established a yaml scalar key node.
        const keyNode: { value?: BoundaryValue } = overlapCast(pairRecord.key);
        if (keyNode.value === "<<") {
          pushError(
            diagnostics,
            "merge_key",
            "YAML merge keys are not supported.",
          );
        }
      }
    },
  });

  if (
    document.contents &&
    countEntries(overlapCast(document.contents), 0) > MAX_COLLECTION_ENTRIES
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

  const value = jsonValue(overlapCast(document.contents), diagnostics);
  const record = isJsonObject(value) ? value : {};
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
