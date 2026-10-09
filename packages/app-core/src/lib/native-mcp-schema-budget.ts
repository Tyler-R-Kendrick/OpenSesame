/** Iterative bounds run before schema traversal or synchronous validation. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { NativeMcpError } from "./native-mcp-target.js";

export function nativeMcpJsonBudget(value: BoundaryValue): number {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  let characters = 0;
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) break;
    if (++nodes > 512 || entry.depth > 24)
      throw new NativeMcpError("schema-limits");
    const children = jsonChildren(entry.value, 512 - nodes - stack.length);
    for (const child of children)
      stack.push({ value: child, depth: entry.depth + 1 });
    if (isString(entry.value)) characters += entry.value.length;
    if (characters > 16_384) throw new NativeMcpError("schema-limits");
  }
  // Include quadratic collection work (uniqueItems), not just string matching.
  return nodes * Math.max(nodes, characters);
}
function jsonChildren(
  value: BoundaryValue,
  remaining: number,
): BoundaryValue[] {
  if (Array.isArray(value)) {
    if (value.length > remaining) throw new NativeMcpError("schema-limits");
    return value;
  }
  if (!isJsonObject(value)) return [];
  if (Object.keys(value).length * 2 > remaining)
    throw new NativeMcpError("schema-limits");
  return Object.entries(value).flat();
}
