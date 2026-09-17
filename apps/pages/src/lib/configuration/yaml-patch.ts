import { isMap, isScalar, parseDocument } from "yaml";
import { parseConfigYaml } from "./yaml-profile.js";

function formatScalar(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value === "" || /[:#\n\r]/.test(value) || value !== value.trim()) {
      return JSON.stringify(value);
    }
    return value;
  }
  return JSON.stringify(value);
}

function valueRange(node: { range?: [number, number, number] | null }):
  | [number, number]
  | null {
  const range = node.range;
  if (!range) return null;
  return [range[0], range[1]];
}

/**
 * Replace one top-level scalar in place. Unrelated bytes, including comments
 * and blank lines, are left untouched. Missing keys are appended.
 */
export function patchYamlTopLevel(
  source: string,
  key: string,
  value: unknown,
): string {
  const parsed = parseConfigYaml(source);
  if (!parsed.ok) {
    throw new Error(parsed.diagnostics[0]?.message ?? "invalid YAML");
  }
  const document = parseDocument(source, {
    uniqueKeys: true,
    schema: "core",
    merge: false,
  });
  if (!isMap(document.contents)) {
    const body = `${key}: ${formatScalar(value)}\n`;
    return source.trim() === "" ? body : `${source}\n${body}`;
  }
  for (const item of document.contents.items) {
    if (!isScalar(item.key) || item.key.value !== key) continue;
    if (!item.value) break;
    const range = valueRange(item.value);
    if (!range) break;
    return (
      source.slice(0, range[0]) + formatScalar(value) + source.slice(range[1])
    );
  }
  const suffix = source.endsWith("\n") || source === "" ? "" : "\n";
  return `${source}${suffix}${key}: ${formatScalar(value)}\n`;
}

/** True when two sources differ only in comments and insignificant whitespace. */
export function isPresentationOnlyChange(
  before: string,
  after: string,
): boolean {
  const left = parseConfigYaml(before);
  const right = parseConfigYaml(after);
  if (!left.ok || !right.ok) return false;
  return JSON.stringify(left.value) === JSON.stringify(right.value);
}
