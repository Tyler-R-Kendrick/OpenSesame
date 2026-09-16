/**
 * Resource selectors: an exact id, or a subtree bounded at a separator.
 *
 * The point of a selector type is that there is no third option. A bare string
 * prefix (`repo:acme`) would let `repo:acme-private/secrets` in, and a regular
 * expression would let in whatever the author did not think about. Both are
 * refused at parse time, so nothing downstream has to decide what a pattern
 * was supposed to mean.
 *
 * The string encoding is the one the flat `resources` field already uses — `*`,
 * `repo:acme/catalog`, `repo:acme/*` — and matches the host plane's
 * `crates/domain/src/permission/scope.rs` byte for byte. What is new is that
 * anything outside that grammar throws instead of becoming a pattern that
 * quietly matches nothing.
 */

import { DomainError } from "./errors.js";

/** Longest resource string accepted. Bounds hostile input. */
export const MAX_RESOURCE_LENGTH = 512;

/** The two separators a subtree may be bounded at. */
export type ScopeSeparator = "/" | ":";

/** A resource selector. */
export type ResourceScope =
  | { readonly kind: "everything" }
  | { readonly kind: "exact"; readonly id: string }
  | {
      readonly kind: "subtree";
      readonly prefix: string;
      readonly separator: ScopeSeparator;
    };

/** A typed refusal, so a caller can tell a bad selector from a bad request. */
export class PermissionRefused extends DomainError {
  constructor(what: string, why: string) {
    super("INVARIANT_VIOLATION", `${what}: ${why}`, { what, why });
    this.name = "PermissionRefused";
  }
}

export function refuse(what: string, why: string): never {
  throw new PermissionRefused(what, why);
}

/** Substrings that mean somebody wrote a pattern this grammar cannot honour. */
const PATTERN_LOOKALIKES = [".*", ".+", "**", "?", "[^"] as const;

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parse the string encoding.
 *
 * A regex here would not widen anything — an exact selector matches by
 * equality — which is precisely why it is refused rather than tolerated: an
 * author who believed they had written a subtree would get a silently dead
 * grant, and a dead grant gets debugged by widening something else.
 */
export function parseResourceScope(pattern: string): ResourceScope {
  const what = `resource selector ${JSON.stringify(pattern)}`;
  if (pattern.length === 0) refuse(what, "is empty");
  if (pattern.length > MAX_RESOURCE_LENGTH) {
    refuse(what, `is longer than ${MAX_RESOURCE_LENGTH} characters`);
  }
  if (pattern.trim() !== pattern) {
    refuse(what, "has leading or trailing whitespace");
  }
  if (hasControlCharacter(pattern)) {
    refuse(what, "contains a control character");
  }
  const lookalike = PATTERN_LOOKALIKES.find((needle) =>
    pattern.includes(needle),
  );
  if (lookalike !== undefined) {
    refuse(
      what,
      `contains ${JSON.stringify(lookalike)}; a selector is an exact id or a \`prefix<sep>*\` subtree, never a pattern`,
    );
  }
  if (pattern === "*") return { kind: "everything" };
  for (const separator of ["/", ":"] as const) {
    const suffix = `${separator}*`;
    if (pattern.endsWith(suffix)) {
      const prefix = pattern.slice(0, -suffix.length);
      if (prefix.length === 0) refuse(what, "is a subtree with no prefix");
      if (prefix.includes("*")) refuse(what, "carries more than one `*`");
      return { kind: "subtree", prefix, separator };
    }
  }
  if (pattern.includes("*")) {
    refuse(what, "is a bare prefix; write `prefix/*` or `prefix:*`");
  }
  return { kind: "exact", id: pattern };
}

/** The string encoding, byte-identical to what `parseResourceScope` accepts. */
export function encodeResourceScope(scope: ResourceScope): string {
  switch (scope.kind) {
    case "everything":
      return "*";
    case "exact":
      return scope.id;
    case "subtree":
      return `${scope.prefix}${scope.separator}*`;
  }
}

/** True when `resource` is inside `scope`. */
export function scopeMatches(scope: ResourceScope, resource: string): boolean {
  switch (scope.kind) {
    case "everything":
      return true;
    case "exact":
      return scope.id === resource;
    case "subtree": {
      const head = `${scope.prefix}${scope.separator}`;
      return resource.startsWith(head) && resource.length > head.length;
    }
  }
}

/**
 * True when every resource `child` covers is also covered by `parent`.
 *
 * Used for attenuation, where comparing selectors by equality would refuse
 * legitimate narrowing (`repo:acme/catalog` under `repo:acme/*`) and comparing
 * them by string prefix would accept illegitimate widening.
 */
export function scopeContains(
  parent: ResourceScope,
  child: ResourceScope,
): boolean {
  if (parent.kind === "everything") return true;
  if (child.kind === "everything") return false;
  if (child.kind === "exact") return scopeMatches(parent, child.id);
  if (parent.kind === "exact") return false;
  // Either the same subtree, or a subtree whose own root already sits inside
  // this one — in which case everything below that root does too.
  return (
    (parent.prefix === child.prefix && parent.separator === child.separator) ||
    scopeMatches(parent, child.prefix)
  );
}
