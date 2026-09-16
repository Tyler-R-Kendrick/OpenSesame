import type { AccessRealm } from "./realm.js";
import { refuseAccessDomain } from "./realm.js";
import type { DomainLifetime } from "./temporal.js";
import { PERMANENT, assertLifetimeWellFormed } from "./temporal.js";

/**
 * The longest a domain slug may be. Matches the DNS label limit, because a
 * domain path is the kind of thing that ends up in a URL, a filename, and an
 * operator's terminal.
 */
export const MAX_DOMAIN_SLUG_CHARS = 63;

/**
 * The longest a human-facing domain name may be. Long enough for a real team
 * name, short enough that a path stays readable on a phone.
 */
export const MAX_DOMAIN_DISPLAY_NAME_CHARS = 128;

/** Whether a domain accepts control from above. */
export type InheritanceMode = "inherit" | "isolated";

/**
 * A domain's link to a vault, carrying the project its envelopes are sealed
 * against.
 *
 * The `projectId` is not a convenience copy: `crates/human-vault` binds it into
 * every envelope's AEAD associated data (ADR 0038), so it is part of the
 * ciphertext's identity. `bindVault` is the only constructor and takes the
 * project from the realm, so a binding cannot disagree with where it lives.
 */
export interface VaultBinding {
  readonly vaultId: string;
  readonly projectId: string;
}

export function bindVault(realm: AccessRealm, vaultId: string): VaultBinding {
  return { vaultId, projectId: realm.projectId };
}

/** Refuse a vault sealed against another project. */
export function assertBindingMatchesRealm(
  binding: VaultBinding,
  realm: AccessRealm,
): void {
  if (binding.projectId === realm.projectId) return;
  throw refuseAccessDomain(
    "vault_binding",
    `Vault ${binding.vaultId} is sealed against ${binding.projectId}, realm is ${realm.projectId}`,
    { vaultId: binding.vaultId, sealedAgainst: binding.projectId },
  );
}

/** A node in a realm's access-domain forest. */
export interface AccessDomain {
  readonly id: string;
  readonly realm: AccessRealm;
  /** Absent for a root. A forest has several. */
  readonly parentId?: string;
  readonly slug: string;
  readonly displayName: string;
  readonly inheritance: InheritanceMode;
  readonly lifetime: DomainLifetime;
  readonly vaultBinding?: VaultBinding;
  readonly createdAt: Date;
}

/** What a caller supplies; everything else has a default. */
export interface NewAccessDomain {
  readonly id: string;
  readonly realm: AccessRealm;
  readonly parentId?: string;
  readonly slug: string;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly inheritance?: InheritanceMode;
  readonly lifetime?: DomainLifetime;
  readonly vaultBinding?: VaultBinding;
}

/** An access domain under construction, before it is handed out as readonly. */
type MutableAccessDomain = {
  -readonly [K in keyof AccessDomain]: AccessDomain[K];
};

/** The same, for the input record a rebuild assembles. */
type MutableNewAccessDomain = {
  -readonly [K in keyof NewAccessDomain]: NewAccessDomain[K];
};

/**
 * Build a domain, checking everything a bare node can check.
 *
 * A node knows nothing about the forest, so parent existence, depth, sibling
 * uniqueness and the lifetime-under-parent rule are all checked at insert.
 */
export function makeAccessDomain(input: NewAccessDomain): AccessDomain {
  assertSlug(input.slug);
  assertDisplayName(input.displayName);
  const lifetime = input.lifetime ?? PERMANENT;
  assertLifetimeWellFormed(lifetime, input.createdAt);
  if (input.vaultBinding !== undefined) {
    assertBindingMatchesRealm(input.vaultBinding, input.realm);
  }
  // Optional fields are assigned only when present: this repo runs
  // `exactOptionalPropertyTypes`, so `parentId: undefined` is not the same
  // type as an absent parent, and a root is an absent parent.
  const domain: MutableAccessDomain = {
    id: input.id,
    realm: input.realm,
    slug: input.slug,
    displayName: input.displayName,
    inheritance: input.inheritance ?? "inherit",
    lifetime,
    createdAt: input.createdAt,
  };
  if (input.parentId !== undefined) domain.parentId = input.parentId;
  if (input.vaultBinding !== undefined) {
    domain.vaultBinding = input.vaultBinding;
  }
  return domain;
}

export function isRoot(domain: AccessDomain): boolean {
  return domain.parentId === undefined;
}

/**
 * The same domain under a different parent, or under none.
 *
 * Rebuilt field by field rather than spread-and-deleted: with
 * `exactOptionalPropertyTypes`, a root is an *absent* `parentId`, not one set
 * to `undefined`, and re-running `makeAccessDomain` re-checks the node on the
 * way out. Whether the move is legal is the forest's question.
 */
export function reparented(
  domain: AccessDomain,
  parentId?: string,
): AccessDomain {
  const input: MutableNewAccessDomain = {
    id: domain.id,
    realm: domain.realm,
    slug: domain.slug,
    displayName: domain.displayName,
    createdAt: domain.createdAt,
    inheritance: domain.inheritance,
    lifetime: domain.lifetime,
  };
  if (parentId !== undefined) input.parentId = parentId;
  if (domain.vaultBinding !== undefined) {
    input.vaultBinding = domain.vaultBinding;
  }
  return makeAccessDomain(input);
}

/**
 * Slug rules: a lowercase DNS-ish label.
 *
 * Narrow on purpose. A slug appears in a path, so anything that could be read
 * as path structure (`/`, `.`, `..`) or that differs only by case is refused
 * rather than normalized — two domains whose paths differ only in case are two
 * domains an operator cannot tell apart.
 */
export function assertSlug(slug: string): void {
  if (slug.length === 0) {
    throw refuseAccessDomain("invalid", "Domain slug is empty");
  }
  if ([...slug].length > MAX_DOMAIN_SLUG_CHARS) {
    throw refuseAccessDomain(
      "invalid",
      `Domain slug exceeds ${MAX_DOMAIN_SLUG_CHARS} characters`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw refuseAccessDomain(
      "invalid",
      `Domain slug "${slug}" is not lowercase [a-z0-9-]`,
      {
        slug,
      },
    );
  }
  if (slug.startsWith("-") || slug.endsWith("-")) {
    throw refuseAccessDomain(
      "invalid",
      `Domain slug "${slug}" starts or ends with a hyphen`,
      { slug },
    );
  }
}

/**
 * Display-name rules: present, bounded, single-line. A name with a newline in
 * it can misrepresent a listing.
 */
export function assertDisplayName(displayName: string): void {
  if (displayName.trim().length === 0) {
    throw refuseAccessDomain("invalid", "Domain display name is blank");
  }
  if ([...displayName].length > MAX_DOMAIN_DISPLAY_NAME_CHARS) {
    throw refuseAccessDomain(
      "invalid",
      `Domain display name exceeds ${MAX_DOMAIN_DISPLAY_NAME_CHARS} characters`,
    );
  }
  if (/[\p{Cc}\p{Cf}]/u.test(displayName)) {
    throw refuseAccessDomain(
      "invalid",
      "Domain display name carries a control character",
    );
  }
}
