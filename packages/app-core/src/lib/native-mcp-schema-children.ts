/** Mirror interpreter schema-bearing keyword traversal, preserving property names. */
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
} from "@opensesame/os-domain";
const MAPS = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);
const ARRAYS = new Set(["prefixItems", "items", "allOf", "anyOf", "oneOf"]);
const IGNORED = new Set([
  "$ref",
  "$schema",
  "$vocabulary",
  "$comment",
  "default",
  "enum",
  "const",
  "required",
  "type",
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "multipleOf",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxProperties",
  "minProperties",
]);
export function nativeMcpSchemaChildren(schema: JsonObject): JsonValue[] {
  const children: JsonValue[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (IGNORED.has(key)) continue;
    if (MAPS.has(key) && isJsonObject(value))
      children.push(...Object.values(value).filter(schemaValue));
    else if (ARRAYS.has(key) && Array.isArray(value))
      children.push(...value.filter(schemaValue));
    else if (schemaValue(value)) children.push(value);
  }
  return children;
}
function schemaValue(
  value: JsonValue | undefined,
): value is JsonObject | boolean {
  return isJsonObject(value) || value === true || value === false;
}
