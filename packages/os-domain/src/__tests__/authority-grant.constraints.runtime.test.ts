// Typed domain-policy proof only; no Host signature or authority verdict is mocked.
import { expect, it } from "vitest";
import {
  type AuthorityGrant,
  type AuthorityGrantConstraints,
  assertAuthorityGrantActive,
  authorityGrantPermitsResource,
  validateAuthorityGrantAttenuation,
} from "../authority-grant.js";
import { DomainError } from "../errors.js";

const start = new Date("2026-10-07T12:00:00.000Z");
const finish = new Date("2026-10-07T13:00:00.000Z");
function parent(): AuthorityGrant {
  return {
    id: "grant:root",
    version: 1,
    issuerPrincipalId: "principal:owner",
    beneficiaryPrincipalId: "principal:delegate",
    actorId: null,
    clientId: null,
    actorInstanceId: null,
    proofKeyThumbprint: null,
    organizationId: "org:example",
    projectId: "project:example",
    environmentId: null,
    connectionId: "connection:example",
    actions: ["repository.read"],
    resources: ["repo:example/*"],
    parentGrantId: null,
    delegationDepth: 0,
    createdAt: start,
    revokedAt: null,
    constraints: {
      audiences: ["https://api.example"],
      notBefore: start,
      expiresAt: finish,
      requiredAssurance: "mfa",
      authenticationMaxAgeSeconds: 300,
      allowedNetworks: ["internal"],
      parameterRulesDigest: "policy-v1",
      budgets: { calls: 10 },
      maximumDelegationDepth: 2,
      offlineUse: "read_only",
      rawCredentialExport: false,
    },
  };
}
function child(
  original: AuthorityGrant,
  patch: Partial<AuthorityGrantConstraints> = {},
): AuthorityGrant {
  return {
    ...original,
    id: "grant:child",
    parentGrantId: original.id,
    delegationDepth: 1,
    resources: ["repo:example/repository"],
    constraints: {
      ...original.constraints,
      budgets: { calls: 5 },
      maximumDelegationDepth: 1,
      ...patch,
    },
  };
}

it("permits meaningful stronger constraints while rejecting each independent authority expansion", () => {
  const original = parent();
  const before = structuredClone(original);
  const tightened = child(original, {
    notBefore: new Date(start.getTime() + 1000),
    expiresAt: new Date(finish.getTime() - 1000),
    requiredAssurance: "phishing-resistant",
    authenticationMaxAgeSeconds: 60,
    offlineUse: "forbidden",
    budgets: { calls: 0 },
  });
  expect(() =>
    validateAuthorityGrantAttenuation(original, tightened),
  ).not.toThrow();
  const expanded: Partial<AuthorityGrantConstraints>[] = [
    { audiences: [] },
    { audiences: ["https://foreign.example"] },
    { notBefore: null },
    { notBefore: new Date(start.getTime() - 1) },
    { notBefore: finish },
    { expiresAt: new Date(finish.getTime() + 1) },
    { requiredAssurance: null },
    { requiredAssurance: "password" },
    { requiredAssurance: "unrecognized-assurance" },
    { authenticationMaxAgeSeconds: null },
    { authenticationMaxAgeSeconds: 301 },
    { allowedNetworks: ["external"] },
    { parameterRulesDigest: "different-policy" },
    { offlineUse: "pre_authorized" },
    { rawCredentialExport: true },
    { budgets: {} },
    { budgets: { calls: -1 } },
    { budgets: { calls: 0.5 } },
    { budgets: { calls: 11 } },
    { maximumDelegationDepth: 3 },
  ];
  for (const patch of expanded) {
    expect(() =>
      validateAuthorityGrantAttenuation(original, child(original, patch)),
    ).toThrow(DomainError);
    expect(original).toEqual(before);
  }
  expect(() =>
    validateAuthorityGrantAttenuation(original, {
      ...child(original),
      parentGrantId: "grant:foreign",
    }),
  ).toThrow(DomainError);
  expect(() =>
    validateAuthorityGrantAttenuation(original, {
      ...child(original),
      organizationId: "org:foreign",
    }),
  ).toThrow(DomainError);
  expect(() =>
    validateAuthorityGrantAttenuation(original, {
      ...child(original),
      delegationDepth: 0,
    }),
  ).toThrow(DomainError);
  expect(original).toEqual(before);
});

it("enforces exact validity boundaries and ignores malformed resource selectors rather than granting access", () => {
  const original = parent();
  const before = structuredClone(original);
  expect(() =>
    assertAuthorityGrantActive(original, new Date(start.getTime() - 1)),
  ).toThrow(DomainError);
  expect(() => assertAuthorityGrantActive(original, start)).not.toThrow();
  expect(() =>
    assertAuthorityGrantActive(original, new Date(finish.getTime() - 1)),
  ).not.toThrow();
  expect(() => assertAuthorityGrantActive(original, finish)).toThrow(
    DomainError,
  );
  expect(
    authorityGrantPermitsResource(
      { ...original, resources: ["repo:invalid/**/bad", "repo:example/*"] },
      "repo:example/repository",
    ),
  ).toBe(true);
  expect(
    authorityGrantPermitsResource(
      { ...original, resources: ["repo:invalid/**/bad"] },
      "repo:example/repository",
    ),
  ).toBe(false);
  expect(original).toEqual(before);
});
