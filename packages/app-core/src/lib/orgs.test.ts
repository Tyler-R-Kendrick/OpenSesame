/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceIdentitySeams } from "./device-identity.js";
import { identitySeams } from "./identity.js";
import {
  GUEST_PROFILE_ID,
  ORG_SLUG_RE,
  activeOrgProfileId,
  discardOrgProfile,
  joinOrgTenant,
  listOrgMemberships,
  lookupOrgByDomain,
  lookupOrgTenant,
  orgAuthUpstream,
  orgSeams,
  routeOrgMethod,
  setActiveOrgProfileId,
} from "./orgs.js";

const originalIdentityJson = identitySeams.identityJson;
const originalIdentityBase = identitySeams.identityBase;

describe("orgs", () => {
  const originalRemote = deviceIdentitySeams.remoteIdentityApi;
  beforeEach(() => {
    // The profile selection lives in memory for the session now (sealed in
    // the tomb between sessions) — reset it like a fresh lock would.
    discardOrgProfile();
    sessionStorage.clear();
    identitySeams.identityBase = () => "http://127.0.0.1:18788";
    deviceIdentitySeams.remoteIdentityApi = () => "http://127.0.0.1:18788";
    identitySeams.identityJson = originalIdentityJson;
  });

  afterEach(() => {
    identitySeams.identityJson = originalIdentityJson;
    identitySeams.identityBase = originalIdentityBase;
    deviceIdentitySeams.remoteIdentityApi = originalRemote;
  });

  it("refuses the directory calls when no capability installed one", async () => {
    // An installation that did not take `identity.federation` has no
    // directory to ask. Saying so is the answer; reaching for an endpoint
    // that is not there is not (ADR 0130, ADR 0090).
    identitySeams.identityJson = vi.fn() as typeof identitySeams.identityJson;
    for (const call of [
      () => lookupOrgTenant("acme"),
      () => lookupOrgByDomain("acme.example"),
      () => listOrgMemberships(),
      () => joinOrgTenant("acme", "sso", "id-token"),
    ]) {
      await expect(call()).rejects.toThrow(/No organization directory/);
    }
    expect(identitySeams.identityJson).not.toHaveBeenCalled();
  });

  it("starts on the guest profile and persists a selection in this tab", () => {
    expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
    setActiveOrgProfileId("org:1");
    expect(activeOrgProfileId()).toBe("org:1");
  });

  it("routes a method with a browser issuer through this browser", () => {
    expect(
      routeOrgMethod({
        kind: "sso",
        label: "SSO",
        issuer: "https://idp.example",
      }),
    ).toEqual({ via: "browser", issuer: "https://idp.example", kind: "sso" });
  });

  it("routes every method the browser cannot speak through the broker", () => {
    // Native SAML: metadata configured server-side, no OIDC issuer at all.
    expect(
      routeOrgMethod({ kind: "saml", label: "SAML", native: true }),
    ).toEqual({ via: "brokered" });
    // A method the server published without an issuer must still be startable.
    expect(routeOrgMethod({ kind: "sso", label: "SSO" })).toEqual({
      via: "brokered",
    });
    // LDAP is a directory bind, and a directory password is never typed here.
    expect(
      routeOrgMethod({
        kind: "ldap",
        label: "Directory",
        issuer: "ldaps://dir.example",
      }),
    ).toEqual({ via: "brokered" });
  });

  it("falls back to the Identity API when a method has no issuer of its own", () => {
    expect(
      orgAuthUpstream(
        {
          slug: "acme",
          displayName: "Acme",
          state: "active",
          authMethods: [],
        },
        { kind: "saml", label: "SAML", native: true },
      ),
    ).toEqual({
      id: "org:acme:saml",
      displayName: "Acme",
      issuer: "http://127.0.0.1:18788",
      accountKind: "SAML",
    });
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
