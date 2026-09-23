/**
 * One field, three roads: the "Email or organization" identifier classifier.
 *
 * A work email finds the organization by its domain; a slug names it
 * directly; a personal email falls back to a magic link. Classification is
 * local and instant — nothing leaves this device until the person commits,
 * and even then only the domain travels for discovery (D12/T28).
 */

import { ORG_SLUG_RE } from "./orgs.js";
import { workEmailDomain } from "./providers.js";

export type IdentifierClassification =
  /** Looks like an email; `domain` is what discovery may use. */
  | { kind: "email"; email: string; domain: string }
  /** Looks like an organization slug. */
  | { kind: "slug"; slug: string }
  /** Nothing routable was typed. */
  | { kind: "unknown" };

export function classifyIdentifier(raw: string): IdentifierClassification {
  const value = raw.trim();
  if (!value) return { kind: "unknown" };
  if (value.includes("@")) {
    const domain = workEmailDomain(value);
    if (!domain) return { kind: "unknown" };
    return { kind: "email", email: value, domain };
  }
  const slug = value.toLowerCase();
  if (ORG_SLUG_RE.test(slug)) return { kind: "slug", slug };
  return { kind: "unknown" };
}
