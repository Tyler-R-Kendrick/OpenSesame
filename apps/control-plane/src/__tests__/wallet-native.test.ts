import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import type { Variables } from "../middleware/context.js";
import {
  WALLET_NATIVE_ADR,
  WALLET_NATIVE_SURFACES,
  type WalletNativeMounts,
  mountWalletNativeRoutes,
  walletNativeCapabilities,
} from "../routes/wallet-native.js";

/** Read a response body at a known shape through the sanctioned cast helper. */
async function readJson<T>(res: Response): Promise<T> {
  return overlapCast<JsonObject, T>(await res.json());
}

/** A bare app with just the correlation-id seam the stubs read. */
function testApp(
  mounts: WalletNativeMounts = {},
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("correlationId", "corr-test");
    await next();
  });
  mountWalletNativeRoutes(app, mounts);
  return app;
}

type CapabilityRow = {
  id: string;
  mountPath: string;
  state: string;
  reason?: string;
  adr: string;
};

type StubBody = {
  error: string;
  capability: string;
  reason: string;
  adr: string;
  correlationId?: string;
};

describe("wallet-native capability inventory", () => {
  it("reports all four surfaces unavailable with a reason when nothing is wired", () => {
    const caps = walletNativeCapabilities();
    expect(caps).toHaveLength(4);
    for (const cap of caps) {
      expect(cap.state).toBe("unavailable");
      expect((cap.reason ?? "").length).toBeGreaterThan(0);
      expect(cap.adr).toBe(WALLET_NATIVE_ADR);
    }
    expect([...caps.map((c) => c.id)].sort()).toEqual([
      "openid4vci.issuer",
      "openid4vp.verifier",
      "rendezvous",
      "wallet.registration",
    ]);
  });

  it("marks a surface available and drops its reason once a router is supplied", () => {
    const caps = walletNativeCapabilities({ openid4vpVerifier: new Hono() });
    const vp = caps.find((c) => c.id === "openid4vp.verifier");
    expect(vp?.state).toBe("available");
    expect(vp?.reason).toBeUndefined();
    // The others stay honest.
    const others = caps.filter((c) => c.id !== "openid4vp.verifier");
    expect(others.every((c) => c.state === "unavailable")).toBe(true);
  });
});

describe("wallet-native typed Unavailable stubs", () => {
  it("refuses the prefix root and every subpath with a typed 501, on every method", async () => {
    const app = testApp();
    for (const surface of WALLET_NATIVE_SURFACES) {
      for (const [path, method] of [
        [surface.mountPath, "GET"],
        [`${surface.mountPath}/anything/deep`, "POST"],
        [`${surface.mountPath}/credential`, "PUT"],
      ] as const) {
        const res = await app.request(path, { method });
        expect(res.status, `${method} ${path}`).toBe(501);
        const body = await readJson<StubBody>(res);
        expect(body.error).toBe("capability_unavailable");
        expect(body.capability).toBe(surface.id);
        expect(body.adr).toBe(WALLET_NATIVE_ADR);
        expect(body.correlationId).toBe("corr-test");
      }
    }
  });

  it("closes the bypass: an unknown subpath/method is refused, never 404'd", async () => {
    const app = testApp();
    const res = await app.request("/v1/rendezvous/whatever/unknown", {
      method: "DELETE",
    });
    expect(res.status).toBe(501);
  });

  it("serves the runtime support matrix publicly", async () => {
    const app = testApp();
    const res = await app.request("/v1/wallet-native/capabilities");
    expect(res.status).toBe(200);
    const body = await readJson<{ capabilities: CapabilityRow[] }>(res);
    expect(body.capabilities).toHaveLength(4);
    expect(body.capabilities.every((c) => c.state === "unavailable")).toBe(
      true,
    );
  });

  it("routes to a real sub-router when one is supplied, bypassing the stub", async () => {
    const real = new Hono<{ Variables: Variables }>();
    real.get("/ping", (c) => c.json({ ok: true }, 200));
    const app = testApp({ openid4vpVerifier: real });

    const hit = await app.request("/v1/openid4vp/ping");
    expect(hit.status).toBe(200);
    expect((await readJson<{ ok: boolean }>(hit)).ok).toBe(true);

    // A sibling surface with no router still refuses.
    const stubbed = await app.request("/v1/openid4vci/credential", {
      method: "POST",
    });
    expect(stubbed.status).toBe(501);

    const matrix = await app.request("/v1/wallet-native/capabilities");
    const body = await readJson<{ capabilities: CapabilityRow[] }>(matrix);
    const vp = body.capabilities.find((c) => c.id === "openid4vp.verifier");
    expect(vp?.state).toBe("available");
  });
});

describe("wallet-native wiring in the real composition root", () => {
  it("mounts the stubs alongside — not instead of — the SIOP routes", async () => {
    const { app } = createControlPlane();

    // Wallet-native surfaces are wired and refuse honestly.
    const vp = await app.request("/v1/openid4vp/authorize", { method: "POST" });
    expect(vp.status).toBe(501);
    expect((await readJson<StubBody>(vp)).capability).toBe(
      "openid4vp.verifier",
    );

    const matrix = await app.request("/v1/wallet-native/capabilities");
    expect(matrix.status).toBe(200);

    // SIOP (ADR 0117) is preserved: still mounted, still gated on a principal.
    const siop = await app.request("/v1/siop/challenges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: "https://id.example/siop-bridge" }),
    });
    expect(siop.status).toBe(401);
  });
});
