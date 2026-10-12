/**
 * Published vault address `owner/slug` (ADR 0181).
 *
 * Not the sealed display name (ADR 0089). The caller passes `ownerKind`:
 * the spelling does not record user versus organization. `guest` is reserved
 * because it is the continue-as-guest tomb. Segments match the access-domain
 * slug label: 1–63 characters, `[a-z0-9-]`, no leading or trailing hyphen.
 */

export type OrgVaultOwnerKind = "user" | "organization";

export type OrgVaultRef = {
  readonly ownerKind: OrgVaultOwnerKind;
  readonly owner: string;
  readonly slug: string;
};

export type OrgVaultRefRefusal = "empty" | "form" | "segment" | "reserved";

export type ParsedOrgVaultRef =
  | { readonly ok: true; readonly ref: OrgVaultRef }
  | { readonly ok: false; readonly refusal: OrgVaultRefRefusal };

const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** Parse `owner/slug`. No trimming and no case folding. */
export function parseOrgVaultRef(
  input: string,
  ownerKind: OrgVaultOwnerKind,
): ParsedOrgVaultRef {
  if (input.length === 0) return { ok: false, refusal: "empty" };
  const slash = input.indexOf("/");
  if (
    slash <= 0 ||
    slash !== input.lastIndexOf("/") ||
    slash === input.length - 1
  ) {
    return { ok: false, refusal: "form" };
  }
  const owner = input.slice(0, slash);
  const slug = input.slice(slash + 1);
  if (!SEGMENT.test(owner) || !SEGMENT.test(slug)) {
    return { ok: false, refusal: "segment" };
  }
  if (owner === "guest" || slug === "guest") {
    return { ok: false, refusal: "reserved" };
  }
  return { ok: true, ref: { ownerKind, owner, slug } };
}

export function formatOrgVaultRef(ref: OrgVaultRef): string {
  return `${ref.owner}/${ref.slug}`;
}
