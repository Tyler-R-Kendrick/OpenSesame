import { describe, expect, it } from "vitest";
import {
  type AuthorityGrant,
  type AuthorityGrantConstraints,
  DEFAULT_MAXIMUM_DELEGATION_DEPTH,
  assertAuthorityGrantActive,
  authorityGrantPermitsResource,
  validateAuthorityGrantAttenuation,
} from "../authority-grant.js";
import {
  assertInvGa01Attenuation,
  assertInvGa02NoSecretOnAuthorityRecord,
  assertInvGa04FiniteDepth,
  assertInvGa07ActiveState,
  assertInvGa08BudgetConservation,
} from "../authority-invariants.js";
import { DomainError } from "../errors.js";

function constraints(
  overrides: Partial<AuthorityGrantConstraints> = {},
): AuthorityGrantConstraints {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);
  return {
    audiences: ["https://api.example"],
    notBefore: null,
    expiresAt: new Date(now + 3_600_000),
    requiredAssurance: "mfa",
    authenticationMaxAgeSeconds: 600,
    allowedNetworks: [],
    parameterRulesDigest: null,
    budgets: { calls: 10 },
    maximumDelegationDepth: 2,
    offlineUse: "forbidden",
    rawCredentialExport: false,
    ...overrides,
  };
}

function grant(
  overrides: Partial<AuthorityGrant> &
    Pick<AuthorityGrant, "id" | "delegationDepth">,
): AuthorityGrant {
  const now = new Date(Date.UTC(2026, 8, 16, 12, 0, 0));
  return {
    version: 1,
    issuerPrincipalId: "principal:issuer",
    beneficiaryPrincipalId: "principal:beneficiary",
    actorId: null,
    clientId: null,
    actorInstanceId: null,
    proofKeyThumbprint: null,
    organizationId: "org:acme",
    projectId: "project:catalog",
    environmentId: null,
    connectionId: "connection:1",
    actions: ["repository.read", "pull_request.create"],
    resources: ["repo:acme/*"],
    constraints: constraints(),
    parentGrantId: null,
    createdAt: now,
    revokedAt: null,
    ...overrides,
  };
}

describe("GA-A AuthorityGrant", () => {
  it("asserts active grants and refuses revoked or expired ones", () => {
    const now = new Date(Date.UTC(2026, 8, 16, 12, 30, 0));
    const live = grant({ id: "grant:root", delegationDepth: 0 });
    expect(() => assertAuthorityGrantActive(live, now)).not.toThrow();

    expect(() =>
      assertAuthorityGrantActive({ ...live, revokedAt: now }, now),
    ).toThrow(DomainError);

    expect(() =>
      assertAuthorityGrantActive(
        {
          ...live,
          constraints: constraints({
            expiresAt: new Date(Date.UTC(2026, 8, 16, 12, 0, 0)),
          }),
        },
        now,
      ),
    ).toThrow(DomainError);
  });

  it("matches resources with the shared selector grammar", () => {
    const live = grant({ id: "grant:root", delegationDepth: 0 });
    expect(authorityGrantPermitsResource(live, "repo:acme/catalog")).toBe(true);
    expect(authorityGrantPermitsResource(live, "repo:other/x")).toBe(false);
  });

  it("refuses attenuation that widens actions, resources, or budgets", () => {
    const parent = grant({ id: "grant:root", delegationDepth: 0 });
    const child = grant({
      id: "grant:child",
      parentGrantId: parent.id,
      delegationDepth: 1,
      actions: ["repository.read"],
      resources: ["repo:acme/catalog"],
      constraints: constraints({
        budgets: { calls: 5 },
        maximumDelegationDepth: 1,
        expiresAt: parent.constraints.expiresAt,
      }),
    });
    expect(() =>
      validateAuthorityGrantAttenuation(parent, child),
    ).not.toThrow();

    expect(() =>
      validateAuthorityGrantAttenuation(parent, {
        ...child,
        actions: ["repository.read", "repository.admin"],
      }),
    ).toThrow(/actions expanded/);

    expect(() =>
      validateAuthorityGrantAttenuation(parent, {
        ...child,
        constraints: constraints({
          budgets: { calls: 11 },
          maximumDelegationDepth: 1,
          expiresAt: parent.constraints.expiresAt,
        }),
      }),
    ).toThrow(/budget expanded/);
  });
});

describe("GA-A INV-GA asserts", () => {
  it("INV-GA-01 / INV-GA-08: attenuation and budget conservation", () => {
    const parent = grant({ id: "grant:root", delegationDepth: 0 });
    const child = grant({
      id: "grant:child",
      parentGrantId: parent.id,
      delegationDepth: 1,
      actions: ["repository.read"],
      resources: ["repo:acme/catalog"],
      constraints: constraints({
        budgets: { calls: 4 },
        maximumDelegationDepth: 1,
        expiresAt: parent.constraints.expiresAt,
      }),
    });
    expect(() => assertInvGa01Attenuation(parent, child)).not.toThrow();
    expect(() => assertInvGa08BudgetConservation(parent, child)).not.toThrow();
  });

  it("INV-GA-02: refuses secret-shaped fields and raw export", () => {
    const live = grant({ id: "grant:root", delegationDepth: 0 });
    expect(() => assertInvGa02NoSecretOnAuthorityRecord(live)).not.toThrow();
    expect(() =>
      assertInvGa02NoSecretOnAuthorityRecord({
        ...live,
        constraints: { ...live.constraints, rawCredentialExport: true },
      }),
    ).toThrow(/INV-GA-02|raw credential/i);
  });

  it("INV-GA-04/06/07: finite depth, cycle refusal, active state", () => {
    const root = grant({ id: "grant:root", delegationDepth: 0 });
    const child = grant({
      id: "grant:child",
      parentGrantId: root.id,
      delegationDepth: 1,
      actions: ["repository.read"],
      resources: ["repo:acme/catalog"],
      constraints: constraints({
        budgets: { calls: 4 },
        maximumDelegationDepth: 1,
        expiresAt: root.constraints.expiresAt,
      }),
    });
    expect(DEFAULT_MAXIMUM_DELEGATION_DEPTH).toBe(2);
    expect(() => assertInvGa04FiniteDepth([root, child])).not.toThrow();
    expect(() => assertInvGa04FiniteDepth([root, child], 2)).not.toThrow();
    expect(() => assertInvGa04FiniteDepth([root, child, child], 2)).toThrow(
      /cycle/i,
    );
    const now = new Date(Date.UTC(2026, 8, 16, 12, 30, 0));
    expect(() => assertInvGa07ActiveState(root, now)).not.toThrow();
  });
});
