import type { BoundaryValue } from "@opensesame/os-domain";
import { isJsonObject, isString } from "@opensesame/os-domain";
import type { ScimPatchOperation } from "./scim-protocol.js";

export type MemberSelector =
  | { type: "collection" }
  | { type: "valueEq"; value: string }
  | { type: "unsupported" };

const COLLECTION = /^members$/i;
const VALUE_EQ = /^members\s*\[\s*value\s+eq\s+(?:"([^"]*)"|'([^']*)')\s*\]$/i;
const FILTERED = /^members\s*\[/i;

/**
 * Parse a Groups PATCH path targeting `members`.
 *
 * Supported: `members`, and the RFC 7644 selector `members[value eq "id"]`.
 * Anything else in brackets is unsupported and must fail closed.
 */
export function parseMemberSelector(
  path: string | undefined,
): MemberSelector | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  if (COLLECTION.test(trimmed)) return { type: "collection" };
  const match = trimmed.match(VALUE_EQ);
  if (match) return { type: "valueEq", value: match[1] ?? match[2] ?? "" };
  if (FILTERED.test(trimmed)) return { type: "unsupported" };
  return undefined;
}

/** Member ids named by one Groups operation value. */
export function memberIds(value: BoundaryValue | undefined): string[] {
  if (value === undefined) return [];
  if (isJsonObject(value) && value.members !== undefined) {
    return memberIds(value.members);
  }
  const entries = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const entry of entries) {
    if (isString(entry) && entry) {
      ids.push(entry);
      continue;
    }
    if (isJsonObject(entry) && isString(entry.value) && entry.value) {
      ids.push(entry.value);
    }
  }
  return ids;
}

export type MemberIdResolution =
  | { ids: string[] }
  | { error: { detail: string; scimType: string } };

/**
 * Resolve the member ids a PATCH operation names.
 *
 * Selector-only remove (`path: members[value eq "id"]`, no `value`) is a
 * real removal. Bulk remove of the whole collection is refused.
 */
export function resolveMemberIds(
  operation: ScimPatchOperation,
): MemberIdResolution {
  const selector = parseMemberSelector(operation.path);
  if (selector?.type === "unsupported") {
    return {
      error: {
        detail: "Unsupported members filter.",
        scimType: "invalidPath",
      },
    };
  }
  const fromValue = memberIds(operation.value);
  if (selector?.type === "valueEq") {
    return { ids: uniqueIds([selector.value, ...fromValue]) };
  }
  if (
    operation.op === "remove" &&
    selector?.type === "collection" &&
    fromValue.length === 0
  ) {
    return {
      error: {
        detail: "Bulk member removal is not supported.",
        scimType: "invalidValue",
      },
    };
  }
  return { ids: fromValue };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}
