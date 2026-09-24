import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import {
  activeOrgProfileId,
  discardOrgProfile,
  joinOrgTenant,
  listOrgMemberships,
  lookupOrgTenant,
} from "@opensesame/app-core/lib/orgs.js";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOrgDirectory } from "./orgs-directory.js";

const originalIdentityJson = identitySeams.identityJson;
const originalIdentityBase = identitySeams.identityBase;

/**
 * The four Identity-API directory calls, once `identity.federation` has
 * installed them. `orgs.test.ts` holds the other half of the contract: with
 * nothing installed they refuse rather than reach for an endpoint.
 */
describe("org directory", () => {
  const originalRemote = deviceIdentitySeams.remoteIdentityApi;
  let uninstall = () => {};
  beforeEach(() => {
    discardOrgProfile();
    sessionStorage.clear();
    identitySeams.identityBase = () => "http://127.0.0.1:18788";
    deviceIdentitySeams.remoteIdentityApi = () => "http://127.0.0.1:18788";
    identitySeams.identityJson = originalIdentityJson;
    uninstall = installOrgDirectory();
  });

  afterEach(() => {
    uninstall();
    identitySeams.identityJson = originalIdentityJson;
    identitySeams.identityBase = originalIdentityBase;
    deviceIdentitySeams.remoteIdentityApi = originalRemote;
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

  it("returns no memberships when the device host has none", async () => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
    identitySeams.identityBase = () => "";
    // SAFETY: the mock intentionally preserves the seam's exact function type.
    identitySeams.identityJson = vi.fn(async () => ({
      organizations: [],
    })) as typeof identitySeams.identityJson;
    await expect(listOrgMemberships()).resolves.toEqual([]);
    expect(identitySeams.identityJson).toHaveBeenCalled();
  });

  it("puts the refusal back when the capability goes away", async () => {
    uninstall();
    await expect(lookupOrgTenant("acme")).rejects.toThrow(
      /No organization directory/,
    );
  });
});
