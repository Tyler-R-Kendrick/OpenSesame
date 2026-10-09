/** A conservative linear regex subset: anchored atoms, no groups or branching. */
import { type JsonObject, isJsonObject, isString } from "@opensesame/os-domain";
import { NativeMcpError } from "./native-mcp-target.js";

function atomLength(source: string): number {
  const atom =
    /^(?:\[(?:\\[dDsSwW\\\]\-]|[^\[\]\\])+\]|\\[dDsSwW.\-_/]|[a-zA-Z0-9 _/@:\-])/u.exec(
      source,
    );
  if (!atom) throw new NativeMcpError("schema-limits");
  return atom[0].length;
}
function quantifier(source: string) {
  if (/^[+*?]/u.test(source)) return { length: 1, variable: true };
  const match = /^\{([0-9]{1,3})(?:,([0-9]{1,3}))?\}/u.exec(source);
  if (!match) return { length: 0, variable: false };
  const min = Number(match[1]);
  const max = Number(match[2] ?? match[1]);
  if (max > 128 || min > max) throw new NativeMcpError("schema-limits");
  return { length: match[0].length, variable: min !== max };
}
export function assertNativeMcpPattern(pattern: string): void {
  if (
    pattern.length > 256 ||
    !pattern.startsWith("^") ||
    !pattern.endsWith("$")
  )
    throw new NativeMcpError("schema-limits");
  let rest = pattern.slice(1, -1);
  let variables = 0;
  while (rest) {
    rest = rest.slice(atomLength(rest));
    const repeat = quantifier(rest);
    if (repeat.variable && ++variables > 1)
      throw new NativeMcpError("schema-limits");
    rest = rest.slice(repeat.length);
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    throw new NativeMcpError("schema-limits");
  }
}

export function nativeMcpPatternCost(schema: JsonObject): number {
  const pattern = schema.pattern;
  const patterns = schema.patternProperties;
  const own = isString(pattern) ? pattern.length : 0;
  const keys = isJsonObject(patterns)
    ? Object.keys(patterns).reduce((cost, key) => cost + key.length, 0)
    : 0;
  return own + keys + (schema.format === undefined ? 0 : 128);
}
