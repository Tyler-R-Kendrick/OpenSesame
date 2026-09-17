/**
 * GA-F-02 — map an AuthorityGrant onto OpenFGA tuple keys.
 *
 * Projection is a cache with a stated position (storage.md §5), never authority.
 * This module only derives the **additive** relationship tuples a projector may
 * write for one grant. It refuses shapes the model forbids (cohort as grantee)
 * and never invents a wider relation than the grant's actions justify.
 */

import type { AuthorityGrant } from "@opensesame/os-domain";

/** OpenFGA tuple key wire shape (matches `crates/provider-openfga::TupleKey`). */
export type OpenFgaTupleKey = {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
};

export type GrantTupleMappingError = {
  readonly code:
    | "revoked"
    | "cohort_grantee"
    | "empty_actions"
    | "empty_resources"
    | "unmapped_scope";
  readonly message: string;
};

export type GrantTupleMappingResult =
  | { readonly ok: true; readonly tuples: readonly OpenFgaTupleKey[] }
  | { readonly ok: false; readonly error: GrantTupleMappingError };

const WRITEISH =
  /(?:^|[.:_])(write|admin|delete|create|update|mutate|invoke|execute|export)(?:$|[.:_])/i;

type ResourceKind =
  | "vault_item"
  | "vault_collection"
  | "access_domain"
  | "connection"
  | "project"
  | "other";

type ParsedResource = {
  readonly object: string;
  readonly kind: ResourceKind;
};

type TupleBag = {
  readonly tuples: OpenFgaTupleKey[];
  readonly seen: Set<string>;
};

function fail(
  code: GrantTupleMappingError["code"],
  message: string,
): GrantTupleMappingResult {
  return { ok: false, error: { code, message } };
}

function subjectUser(grant: AuthorityGrant): string {
  return `user:${grant.beneficiaryPrincipalId}`;
}

function isWriteish(actions: readonly string[]): boolean {
  for (const action of actions) {
    if (WRITEISH.test(action)) return true;
  }
  return false;
}

function projectRelation(actions: readonly string[]): "viewer" | "developer" {
  return isWriteish(actions) ? "developer" : "viewer";
}

function vaultRelation(actions: readonly string[]): "reader" | "writer" {
  return isWriteish(actions) ? "writer" : "reader";
}

function domainRelation(actions: readonly string[]): "member" | "admin" {
  return isWriteish(actions) ? "admin" : "member";
}

function parseResourceObject(resource: string): ParsedResource | "cohort" {
  const trimmed = resource.trim();
  if (trimmed.startsWith("cohort:") || trimmed.includes("cohort#")) {
    return "cohort";
  }
  if (trimmed.startsWith("vault_item:")) {
    return { object: trimmed, kind: "vault_item" };
  }
  if (trimmed.startsWith("vault_collection:")) {
    return { object: trimmed, kind: "vault_collection" };
  }
  if (trimmed.startsWith("access_domain:")) {
    return { object: trimmed, kind: "access_domain" };
  }
  if (trimmed.startsWith("connection:")) {
    return { object: trimmed, kind: "connection" };
  }
  if (trimmed.startsWith("project:")) {
    return { object: trimmed, kind: "project" };
  }
  return { object: trimmed, kind: "other" };
}

function pushTuple(bag: TupleBag, tuple: OpenFgaTupleKey): void {
  const key = `${tuple.object}#${tuple.relation}@${tuple.user}`;
  if (bag.seen.has(key)) return;
  bag.seen.add(key);
  bag.tuples.push(tuple);
}

/** Host/domain IDs may already carry their type prefix; never double-prefix. */
function typedObject(prefix: "connection" | "project", id: string): string {
  const trimmed = id.trim();
  const head = `${prefix}:`;
  return trimmed.startsWith(head) ? trimmed : `${head}${trimmed}`;
}

function pushScopeTuples(grant: AuthorityGrant, bag: TupleBag): void {
  const user = subjectUser(grant);
  if (grant.connectionId !== null) {
    pushTuple(bag, {
      user,
      relation: "user",
      object: typedObject("connection", grant.connectionId),
    });
  }
  if (grant.projectId !== null) {
    pushTuple(bag, {
      user,
      relation: projectRelation(grant.actions),
      object: typedObject("project", grant.projectId),
    });
  }
}

function pushParsedResource(
  grant: AuthorityGrant,
  parsed: ParsedResource,
  bag: TupleBag,
): boolean {
  const user = subjectUser(grant);
  switch (parsed.kind) {
    case "connection":
      pushTuple(bag, { user, relation: "user", object: parsed.object });
      return true;
    case "project":
      pushTuple(bag, {
        user,
        relation: projectRelation(grant.actions),
        object: parsed.object,
      });
      return true;
    case "vault_item":
    case "vault_collection":
      pushTuple(bag, {
        user,
        relation: vaultRelation(grant.actions),
        object: parsed.object,
      });
      return true;
    case "access_domain":
      pushTuple(bag, {
        user,
        relation: domainRelation(grant.actions),
        object: parsed.object,
      });
      return true;
    case "other":
      return false;
  }
}

function mapResources(
  grant: AuthorityGrant,
  bag: TupleBag,
): GrantTupleMappingResult | boolean {
  let mappedResource = false;
  for (const resource of grant.resources) {
    const parsed = parseResourceObject(resource);
    if (parsed === "cohort") {
      return fail(
        "cohort_grantee",
        "cohort must never appear as an OpenFGA grantee object for a grant",
      );
    }
    if (pushParsedResource(grant, parsed, bag)) {
      mappedResource = true;
    }
  }
  return mappedResource;
}

function assertProjectable(
  grant: AuthorityGrant,
): GrantTupleMappingResult | null {
  if (grant.revokedAt !== null) {
    return fail("revoked", "revoked grants project nothing");
  }
  if (grant.actions.length === 0) {
    return fail("empty_actions", "a grant with no actions projects nothing");
  }
  if (grant.resources.length === 0) {
    return fail(
      "empty_resources",
      "a grant with no resources projects nothing",
    );
  }
  return null;
}

/**
 * Derive the OpenFGA tuples a projector may write for `grant`.
 *
 * Returns `ok: false` when the grant must not be projected (revoked, empty,
 * or a cohort-shaped resource that would make a cohort a grantee).
 */
export function grantToOpenFgaTuples(
  grant: AuthorityGrant,
): GrantTupleMappingResult {
  const blocked = assertProjectable(grant);
  if (blocked !== null) return blocked;

  const bag: TupleBag = { tuples: [], seen: new Set() };
  pushScopeTuples(grant, bag);

  const mapped = mapResources(grant, bag);
  if (typeof mapped !== "boolean") return mapped;

  if (
    bag.tuples.length === 0 &&
    grant.connectionId === null &&
    grant.projectId === null &&
    !mapped
  ) {
    return fail(
      "unmapped_scope",
      "grant has no connection, project, or typed resource to project",
    );
  }

  return { ok: true, tuples: bag.tuples };
}
