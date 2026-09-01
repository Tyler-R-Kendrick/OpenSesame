/** @vitest-environment jsdom */
/**
 * Who this device is signed in as, folded from the upstream assertion and the
 * Identity session into one display model — and never a raw subject.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeAccount } from "./account.js";
import { type UpstreamIdentity, federationSeams } from "./federation.js";
import { type IdentitySession, identitySeams } from "./identity.js";

const originalIdentity = { ...identitySeams };
const originalFederation = { ...federationSeams };

let identity: UpstreamIdentity | null = null;
let session: IdentitySession | null = null;

const SHOO: UpstreamIdentity = {
  issuer: "https://shoo.dev",
  upstreamId: "shoo",
  idToken: "x.y.z",
  pairwiseSub: "ps_FpbWr3dA8kM_opaque",
  audience: "origin:http://localhost:3000",
  jwksUri: "https://shoo.dev/.well-known/jwks.json",
  expiresAt: Date.now() + 60_000,
};

beforeEach(() => {
  identity = null;
  session = null;
  federationSeams.loadSession = () => identity;
  identitySeams.currentSession = () => session;
  identitySeams.identityBase = () => "http://127.0.0.1:18788";
});

afterEach(() => {
  Object.assign(identitySeams, originalIdentity);
  Object.assign(federationSeams, originalFederation);
});

describe("describeAccount", () => {
  it("is nobody when nothing is signed in", () => {
    expect(describeAccount()).toBeNull();
  });

  it("is a guest when only a provisional principal exists", () => {
    session = {
      principalId: "prn_00008f3c",
      accessToken: "pst",
      issuerOrigin: "http://127.0.0.1:18788",
    };
    expect(describeAccount()).toEqual({
      name: "guest",
      detail: "prn · 8f3c · provisional",
      providerId: null,
      guest: true,
    });
  });

  it("names a Google account through shoo.dev without leaking the subject", () => {
    identity = SHOO;
    const account = describeAccount();
    expect(account).toEqual({
      name: "Google account",
      detail: "via shoo.dev",
      providerId: "google",
      guest: false,
    });
    expect(JSON.stringify(account)).not.toContain("ps_");
  });

  it("prefers a name, then an address, when the person consented to PII", () => {
    identity = { ...SHOO, email: "sam@acme.com" };
    expect(describeAccount()?.name).toBe("sam@acme.com");
    identity = { ...SHOO, email: "sam@acme.com", name: "Sam" };
    expect(describeAccount()?.name).toBe("Sam");
  });

  it("adds the principal's tail beside the way in", () => {
    identity = SHOO;
    session = {
      principalId: "prn_00008f3c",
      accessToken: "pst",
      issuerOrigin: "http://127.0.0.1:18788",
    };
    expect(describeAccount()?.detail).toBe("via shoo.dev · prn · 8f3c");
  });

  it("calls a brokered Identity API sign-in an OpenSesame account", () => {
    identity = {
      ...SHOO,
      issuer: "http://127.0.0.1:18788",
      upstreamId: "brokered",
    };
    expect(describeAccount()?.name).toBe("OpenSesame account");
    expect(describeAccount()?.detail).toBe("via 127.0.0.1:18788");
  });
});
