/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identitySeams } from "./identity.js";
import {
  GUEST_PROFILE_ID,
  ORG_SLUG_RE,
  activeOrgProfileId,
  joinOrgTenant,
  listOrgMemberships,
  lookupOrgTenant,
  orgAuthUpstream,
  orgSeams,
  setActiveOrgProfileId,
} from "./orgs.js";

const originalIdentityJson = identitySeams.identityJson;
const originalIdentityBase = identitySeams.identityBase;

describe("orgs", () => {
  beforeEach(() => {
    sessionStorage.clear();
    identitySeams.identityBase = () => "http://127.0.0.1:18788";
    identitySeams.identityJson = originalIdentityJson;
  });

  afterEach(() => {
    identitySeams.identityJson = originalIdentityJson;
    identitySeams.identityBase = originalIdentityBase;
  });

  it("starts on the guest profile and persists a selection in this tab", () => {
    expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
    setActiveOrgProfileId("org:1");
    expect(activeOrgProfileId()).toBe("org:1");
  });

  it("looks up a tenant by slug", async () => {
    // SAFETY: the fixture has the same request/response function contract as the seam.
    identitySeams.identityJson = vi.fn(async (path: string) => {
      expect(path).toBe("/v1/organizations/tenants/acme");
      return {
        slug: "acme",
        displayName: "Acme",
        state: "active",
        authMethods: [
          { kind: "sso", label: "SSO", issuer: "http://127.0.0.1:9090" },
        ],
      };
    }) as typeof identitySeams.identityJson;
    await expect(lookupOrgTenant("Acme")).resolves.toMatchObject({
      slug: "acme",
      displayName: "Acme",
    });
  });

  it("rejects a malformed slug before calling Identity", async () => {
    // SAFETY: the mock intentionally preserves the seam's exact function type.
    identitySeams.identityJson = vi.fn() as typeof identitySeams.identityJson;
    await expect(lookupOrgTenant("Nope!")).rejects.toThrow(/slug/);
    expect(identitySeams.identityJson).not.toHaveBeenCalled();
  });

  it("joins a tenant and selects that org profile", async () => {
    // SAFETY: the fixture has the same request/response function contract as the seam.
    identitySeams.identityJson = vi.fn(async () => ({
      id: "org:acme",
      slug: "acme",
      displayName: "Acme",
      role: "member",
      state: "active",
    })) as typeof identitySeams.identityJson;
    const joined = await joinOrgTenant("acme", "sso", "id-token");
    expect(joined.id).toBe("org:acme");
    expect(activeOrgProfileId()).toBe("org:acme");
    expect(identitySeams.identityJson).toHaveBeenCalledWith(
      "/v1/organizations/tenants/acme/join",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("lists memberships when Identity is configured", async () => {
    // SAFETY: the fixture has the same request/response function contract as the seam.
    identitySeams.identityJson = vi.fn(async () => ({
      organizations: [{ id: "org:1", slug: "acme", displayName: "Acme" }],
    })) as typeof identitySeams.identityJson;
    await expect(listOrgMemberships()).resolves.toEqual([
      { id: "org:1", slug: "acme", displayName: "Acme" },
    ]);
  });

  it("returns no memberships when Identity is not configured", async () => {
    identitySeams.identityBase = () => "";
    // SAFETY: the mock intentionally preserves the seam's exact function type.
    identitySeams.identityJson = vi.fn() as typeof identitySeams.identityJson;
    await expect(listOrgMemberships()).resolves.toEqual([]);
    expect(identitySeams.identityJson).not.toHaveBeenCalled();
  });

  it("builds an org upstream for federation", () => {
    expect(
      orgAuthUpstream(
        {
          slug: "acme",
          displayName: "Acme",
          state: "active",
          authMethods: [],
        },
        { kind: "saml", label: "SAML", issuer: "http://idp.example" },
      ),
    ).toEqual({
      id: "org:acme:saml",
      displayName: "Acme",
      issuer: "http://idp.example",
      accountKind: "SAML",
    });
    expect(ORG_SLUG_RE.test("acme-corp")).toBe(true);
  });
});
