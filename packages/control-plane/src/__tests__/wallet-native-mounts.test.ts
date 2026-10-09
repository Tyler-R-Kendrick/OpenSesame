/**
 * Default wallet-native mounts: registration + rendezvous are always live.
 */

import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { verifiedPrincipal } from "./authentication-fixture.js";

function testConfig() {
  return {
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    claimPepper: "wallet-native-mount-test-pepper-32b!",
    isProduction: false,
  } as const;
}

type CapabilityRow = { id: string; state: string };

async function readCapabilities(res: Response): Promise<CapabilityRow[]> {
  const parsed: unknown = await res.json();
  if (!isJsonObject(parsed) || !Array.isArray(parsed.capabilities)) {
    throw new Error("capabilities response malformed");
  }
  const rows: CapabilityRow[] = [];
  for (const entry of parsed.capabilities) {
    if (!isJsonObject(entry)) continue;
    const id = entry.id;
    const state = entry.state;
    if (isString(id) && isString(state)) {
      rows.push({ id, state });
    }
  }
  return rows;
}

describe("resolveWalletNativeMounts via createControlPlane", () => {
  it("exposes wallet registration and rendezvous without an override", async () => {
    const { app } = createControlPlane({ config: { ...testConfig() } });
    const caps = await app.request("/v1/wallet-native/capabilities");
    expect(caps.status).toBe(200);
    const rows = await readCapabilities(caps);
    const byId = Object.fromEntries(rows.map((c) => [c.id, c.state]));
    expect(byId["wallet.registration"]).toBe("available");
    expect(byId.rendezvous).toBe("available");
    expect(byId["openid4vp.verifier"]).toBe("available");
    expect(byId["openid4vci.issuer"]).toBe("available");
    expect((await app.request("/v1/openid4vp/ping")).status).toBe(200);
  });

  it("lists registrations for an authenticated principal (empty)", async () => {
    const { app } = createControlPlane({ config: { ...testConfig() } });
    const { auth } = await verifiedPrincipal(app);
    const res = await app.request("/v1/wallet/registrations", {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const parsed: unknown = await res.json();
    if (!isJsonObject(parsed) || !Array.isArray(parsed.registrations)) {
      throw new Error("registrations response malformed");
    }
    expect(parsed.registrations).toEqual([]);
  });

  it("still allows an empty override to keep every surface Unavailable", async () => {
    const { app } = createControlPlane({
      config: { ...testConfig() },
      walletNative: {},
    });
    const caps = await app.request("/v1/wallet-native/capabilities");
    const rows = await readCapabilities(caps);
    expect(rows.every((c) => c.state === "unavailable")).toBe(true);
  });

  it("enables OpenID4VP when the protocol feature flag is on", async () => {
    const { app } = createControlPlane({
      config: {
        ...testConfig(),
        protocolFeatures: {
          oid4vp: true,
          oid4vci: false,
          fedcm: false,
          digitalCredentialsApi: false,
          openidFederation: false,
          sdJwtVc: false,
          tokenStatusList: false,
          presentationAgentIntents: false,
        },
      },
    });
    const caps = await app.request("/v1/wallet-native/capabilities");
    const rows = await readCapabilities(caps);
    const vp = rows.find((c) => c.id === "openid4vp.verifier");
    expect(vp?.state).toBe("available");
    const ping = await app.request("/v1/openid4vp/ping");
    expect(ping.status).toBe(200);
    // SAFETY: ping body is a fixed JSON object from the mounted verifier.
    const body = overlapCast<{ ok: boolean }>(await ping.json());
    expect(body.ok).toBe(true);
  });

  it("enables OpenID4VCI when the protocol feature flag is on", async () => {
    const { app } = createControlPlane({
      config: {
        ...testConfig(),
        protocolFeatures: {
          oid4vp: false,
          oid4vci: true,
          fedcm: false,
          digitalCredentialsApi: false,
          openidFederation: false,
          sdJwtVc: false,
          tokenStatusList: false,
          presentationAgentIntents: false,
        },
      },
    });
    const caps = await app.request("/v1/wallet-native/capabilities");
    const rows = await readCapabilities(caps);
    const issuer = rows.find((c) => c.id === "openid4vci.issuer");
    expect(issuer?.state).toBe("available");
    // Metadata itself requires an https issuer identifier (OID4VCI); the
    // focused issuance suite covers that with an https fixture. Here we only
    // prove the surface is mounted rather than Unavailable.
  });
});
