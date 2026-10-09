/** Admit finite local schema graphs before the interpreter can dereference them. */
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { nativeMcpJsonBudget } from "./native-mcp-schema-budget.js";
import { nativeMcpSchemaChildren } from "./native-mcp-schema-children.js";
import {
  assertNativeMcpPattern,
  nativeMcpPatternCost,
} from "./native-mcp-schema-pattern.js";
import { NativeMcpError } from "./native-mcp-target.js";

const FORBIDDEN = new Set([
  "$id",
  "id",
  "$anchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "$dynamicRef",
  "$dynamicAnchor",
]);
const FORMATS = new Set([
  "date",
  "time",
  "date-time",
  "email",
  "uuid",
  "ipv4",
  "ipv6",
  "hostname",
]);
function assertKeywords(schema: JsonObject): void {
  for (const key of Object.keys(schema))
    if (FORBIDDEN.has(key) || key.startsWith("__"))
      throw new NativeMcpError("schema-limits");
  if (schema.pattern !== undefined) {
    if (!isString(schema.pattern)) throw new NativeMcpError("schema-limits");
    assertNativeMcpPattern(schema.pattern);
  }
  if (isJsonObject(schema.patternProperties))
    for (const pattern of Object.keys(schema.patternProperties))
      assertNativeMcpPattern(pattern);
  if (
    schema.format !== undefined &&
    (!isString(schema.format) || !FORMATS.has(schema.format))
  )
    throw new NativeMcpError("schema-limits");
}
function referenced(root: JsonObject, ref: JsonValue): JsonObject | boolean {
  if (!isString(ref) || !ref.startsWith("#/"))
    throw new NativeMcpError("schema-limits");
  let target: JsonValue | undefined = root;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isJsonObject(target) || !Object.hasOwn(target, key))
      throw new NativeMcpError("schema-limits");
    target = target[key];
  }
  if (!isJsonObject(target) && target !== true && target !== false)
    throw new NativeMcpError("schema-limits");
  return target;
}
function expanded(
  value: JsonValue | undefined,
  root: JsonObject,
  ancestors: Set<JsonObject>,
  depth: number,
): number {
  if (depth > 24) throw new NativeMcpError("schema-limits");
  if (Array.isArray(value)) return sum(value, root, ancestors, depth);
  if (!isJsonObject(value)) return 1;
  if (ancestors.has(value)) throw new NativeMcpError("schema-limits");
  assertKeywords(value);
  const next = new Set(ancestors).add(value);
  const children = nativeMcpSchemaChildren(value);
  if (value.$ref !== undefined) children.push(referenced(root, value.$ref));
  const cost =
    1 + nativeMcpPatternCost(value) + sum(children, root, next, depth);
  if (cost > 512) throw new NativeMcpError("schema-limits");
  return cost;
}
function sum(
  values: (JsonValue | undefined)[],
  root: JsonObject,
  ancestors: Set<JsonObject>,
  depth: number,
): number {
  let cost = 0;
  for (const child of values) {
    cost += expanded(child, root, ancestors, depth + 1);
    if (cost > 512) throw new NativeMcpError("schema-limits");
  }
  return cost;
}
export function nativeMcpSchemaCost(schema: JsonObject): number {
  nativeMcpJsonBudget(schema);
  const bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
  if (bytes > 32_768) throw new NativeMcpError("schema-limits");
  return expanded(schema, schema, new Set(), 0);
}
