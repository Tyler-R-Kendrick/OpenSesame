/**
 * Device-native Identity host — provisional + claims without a remote API.
 */

import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  deviceIdentityFetch,
  resetDeviceIdentitySessionsForTests,
} from "./device-identity-host.js";
import {
  identityPlaneRequest,
  isDeviceIdentityMode,
  resolveIdentityBase,
} from "./device-identity.js";
import { saveSettings } from "./settings.js";
import {
  localDropClaimSeams,
  resetLocalDropClaimsForTests,
} from "./vault/local-drop-claims.js";

function emptyRemoteSettings(): void {
  saveSettings({
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
}

beforeEach(() => {
  emptyRemoteSettings();
  resetDeviceIdentitySessionsForTests();
  resetLocalDropClaimsForTests();
  localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
});

afterEach(() => {
  resetDeviceIdentitySessionsForTests();
  resetLocalDropClaimsForTests();
});

describe("device identity mode", () => {
  it("resolves identityBase to a public Pages issuer when settings are empty", () => {
    expect(isDeviceIdentityMode()).toBe(true);
    expect(resolveIdentityBase().length).toBeGreaterThan(0);
    expect(resolveIdentityBase()).toMatch(/^https?:\/\//);
  });

  it("mints provisional, answers /me, and serves a drop claim round-trip", async () => {
    const minted = await identityPlaneRequest("/v1/principals/provisional", {
      method: "POST",
      body: "{}",
    });
    expect(minted.status).toBe(201);
    const session = overlapCast(await minted.json());
    expect(String(session.principalId)).toMatch(/^prn_/);
    expect(String(session.accessToken).length).toBeGreaterThan(8);

    const me = await identityPlaneRequest("/v1/principals/me", {
      headers: { authorization: `Bearer ${String(session.accessToken)}` },
    });
    expect(me.status).toBe(200);
    const principal = overlapCast(await me.json());
    expect(principal.id).toBe(session.principalId);

    const claimRes = await deviceIdentityFetch("/v1/claims", {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(session.accessToken)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "resource_bundle",
        targetManifest: { kind: "drop", digest: "abc", chunks: ["x"] },
        ttlSeconds: 120,
      }),
    });
    expect(claimRes.status).toBe(201);
    const claim = overlapCast(await claimRes.json());
    const poll = await deviceIdentityFetch(
      `/v1/claims/${encodeURIComponent(String(claim.claimId))}/poll`,
      { headers: { "x-claim-token": String(claim.claimToken) } },
    );
    expect(poll.status).toBe(200);
    expect(overlapCast(await poll.json()).status).toBe("pending");

    const presented = await deviceIdentityFetch("/v1/claims/present", {
      method: "POST",
      body: JSON.stringify({
        token: claim.claimToken,
        userCode: claim.userCode,
      }),
    });
    expect(presented.status).toBe(200);
    expect(overlapCast(await presented.json()).targetManifest).toEqual({
      kind: "drop",
      digest: "abc",
      chunks: ["x"],
    });
  });
});
