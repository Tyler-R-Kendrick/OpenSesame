/** @vitest-environment jsdom */
import { Blob, File } from "node:buffer";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { createEventSealer } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import {
  GOOGLE_WALLET_ENV,
  createGoogleLauncherProvider,
  parseGoogleWalletConfig,
} from "@opensesame/wallet";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { importSPKI, jwtVerify } from "jose";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { configureHost } from "../../../app-core/src/host.js";
import { webLocksDouble } from "../../../app-core/src/lib/__tests__/web-locks-double.js";
import { mayPairLocalAuthority } from "../../../app-core/src/lib/deployment-profile.js";
import { identityPlaneRequest } from "../../../app-core/src/lib/device-identity.js";
import { writeSignInService } from "../../../app-core/src/lib/identity-service.js";
import {
  adoptToken,
  clearSession,
} from "../../../app-core/src/lib/identity.js";
import { kvDelete } from "../../../app-core/src/lib/kv.js";
import { enrollRetiredCredential } from "../../../app-core/src/lib/retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "../../../app-core/src/lib/retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "../../../app-core/src/lib/retired-credentials/unlock.js";
import {
  loadSettings,
  saveSettings,
} from "../../../app-core/src/lib/settings.js";
import { clearVaultSurface } from "../../../app-core/src/lib/vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "../../../app-core/src/lib/vault/store.js";
import { tombFileKey } from "../../../app-core/src/lib/vfs.js";
import {
  disableWalletLauncher,
  listWalletRegistrations,
  registerWalletLauncher,
} from "../../../app-core/src/lib/wallet-registration.js";
import {
  clearHostForTest,
  createTestHost,
} from "../../../app-core/src/test-host.js";
import { createControlPlane } from "../create-app.js";
import type { Variables } from "../middleware/context.js";
import { DurableWalletRegistrationStore } from "../repos/durable-wallet-registration-store.js";
import { createWalletRegistrationRoutes } from "../routes/wallet-registration.js";
import { verifiedPrincipal } from "./authentication-fixture.js";
import { migratedPGlite } from "./migrated-pglite.js";

let client: Awaited<ReturnType<typeof migratedPGlite>> | undefined;
beforeAll(async () => {
  // PGlite's real data-directory archive requires the Node Blob API, which
  // jsdom's DOM Blob does not implement. Keep the service runtime intact.
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("File", File);
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", webcrypto.CryptoKey);
  client = await migratedPGlite();
});
afterAll(async () => {
  try {
    await client?.close();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("uses the real identity transport, verifies the provider signature and preserves durable owner isolation through disablement", async () => {
  if (!client) throw new Error("Missing actual migrated database");
  const previousHost = globalThis.__opensesameAppCoreHost;
  configureHost(createTestHost());
  const previousSettings = loadSettings();
  const previousFetch = globalThis.fetch;
  const password = "wallet-provider-genuine-owner";
  const origin = "https://localhost:5189";
  let created = false;
  const ownerHost = createTestHost({
    locks: webLocksDouble(),
    securityProfile: {
      version: 1,
      profile: "loopback_development",
      canonicalOrigin: window.location.origin,
      headerSecurity: false,
    },
  });
  configureHost(ownerHost);
  try {
    const db = drizzle(client, { schema });
    const sealer = createEventSealer("wallet-provider-durable-fixture");
    const store = new DurableWalletRegistrationStore(
      overlapCast(db),
      () => new Date(),
      sealer,
    );
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const config = parseGoogleWalletConfig({
      [GOOGLE_WALLET_ENV.issuerId]: "3388000000022125777",
      [GOOGLE_WALLET_ENV.classId]: "interaction",
      [GOOGLE_WALLET_ENV.serviceAccountEmail]:
        "wallet@fixture.iam.gserviceaccount.com",
      [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: keys.privateKey,
      [GOOGLE_WALLET_ENV.publicBaseUrl]: origin,
      [GOOGLE_WALLET_ENV.origins]: origin,
    });
    if (!config.enabled)
      throw new Error("Invalid actual provider configuration");
    let vendorCalls = 0;
    const provider = createGoogleLauncherProvider({
      config,
      fetchImpl: async () => {
        vendorCalls += 1;
        return new Response("{}", { status: 503 });
      },
    });
    const wallet = new Hono<{ Variables: Variables }>();
    wallet.route(
      "/registrations",
      createWalletRegistrationRoutes({ store, provider }),
    );
    const cp = createControlPlane({
      processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
      config: { port: 0, publicUrl: origin, issuer: origin },
      walletNative: { walletRegistration: wallet },
    });
    await cp.ctx.systemPrincipalReady;
    const owner = await verifiedPrincipal(cp.app);
    const stranger = await verifiedPrincipal(
      cp.app,
      "wallet-provider-stranger",
    );
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== origin)
        throw new Error("Unexpected HTTP destination");
      expect(request.credentials).toBe("omit");
      requests += 1;
      return cp.app.request(request);
    };
    await clearVaultSurface();
    vaultStore.loadActiveProjectScope();
    await vaultStore.create(password);
    created = true;
    kvDelete(tombFileKey("personal", "retired-credentials.v1"));
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: password,
      retiredPassword: "wallet-provider-retired",
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    writeSignInService(origin);
    // Exercise the real local-destination policy, including the fail-closed
    // unprofiled control, before trusting the application's transport.
    configureHost(createTestHost({ locks: webLocksDouble() }));
    expect(mayPairLocalAuthority()).toBe(false);
    const beforeUnprofiled = requests;
    await expect(
      identityPlaneRequest("/v1/health/live", { credentials: "omit" }),
    ).rejects.toMatchObject({ name: "SecurityError" });
    expect(requests).toBe(beforeUnprofiled);
    configureHost(ownerHost);
    expect(mayPairLocalAuthority()).toBe(true);
    expect(
      (await identityPlaneRequest("/v1/health/live", { credentials: "omit" }))
        .status,
    ).toBe(200);
    await adoptToken(owner.auth.authorization.slice("Bearer ".length));
    const result = await registerWalletLauncher({
      registrationId: "provider-owner",
      header: "Owner launcher",
    });
    const key = await importSPKI(keys.publicKey, "RS256");
    const verified = await jwtVerify(
      result.saveUrl.replace("https://pay.google.com/gp/v/save/", ""),
      key,
    );
    expect(verified.payload.typ).toBe("savetowallet");
    expect(JSON.stringify(verified.payload)).toContain(
      `${origin}/w/provider-owner`,
    );
    expect(JSON.stringify(verified.payload)).not.toContain("totpDetails");
    expect(vendorCalls).toBe(0);
    const replica = new DurableWalletRegistrationStore(
      overlapCast(db),
      () => new Date(),
      sealer,
    );
    expect(await replica.get("provider-owner")).toMatchObject({
      state: "active",
    });
    expect(await listWalletRegistrations()).toHaveLength(1);
    await adoptToken(stranger.auth.authorization.slice("Bearer ".length));
    expect(await listWalletRegistrations()).toEqual([]);
    await expect(disableWalletLauncher("provider-owner")).rejects.toThrow();
    expect((await replica.get("provider-owner"))?.state).toBe("active");
    await adoptToken(owner.auth.authorization.slice("Bearer ".length));
    const disabled = await disableWalletLauncher("provider-owner");
    expect(disabled).toMatchObject({
      state: "disabled",
      googleAcknowledged: false,
    });
    expect((await replica.get("provider-owner"))?.state).toBe("disabled");
    expect(vendorCalls).toBeGreaterThan(0);
    expect(requests).toBeGreaterThan(0);
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(
      vaultStore,
      "wallet-provider-retired",
    );
    const beforeBlocked = requests;
    await expect(
      registerWalletLauncher({
        registrationId: "blocked",
        header: "No forward",
      }),
    ).rejects.toThrow();
    expect(requests).toBe(beforeBlocked);
    expect(await replica.get("blocked")).toBeNull();
    vaultStore.lock();
    await expect(disableWalletLauncher("provider-owner")).rejects.toThrow();
    expect(requests).toBe(beforeBlocked);
    await flushRetiredCredentialTelemetry();
    await vaultStore.unlock(password);
    expect(await listWalletRegistrations()).toMatchObject([
      { state: "disabled" },
    ]);
  } finally {
    try {
      await flushRetiredCredentialTelemetry();
      if (created) {
        vaultStore.lock();
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      clearSession();
      globalThis.fetch = previousFetch;
      saveSettings(previousSettings);
      if (previousHost) configureHost(previousHost);
      else clearHostForTest();
    }
  }
});
