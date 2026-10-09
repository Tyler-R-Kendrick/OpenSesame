// @vitest-environment jsdom
import { nativeGoogleBrowserAvailable } from "@opensesame/app-core/browser/native-google-oauth.js";
import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import { kvSeams } from "@opensesame/app-core/lib/kv.js";
import {
  nativeApiFingerprint,
  nativeApiTarget,
} from "@opensesame/app-core/lib/native-api-target.js";
import { installNativeApiTests } from "@opensesame/app-core/lib/native-api.test-support.js";
import { configureNativeBrowserOAuthConnector } from "@opensesame/app-core/lib/native-browser-oauth-connectors.js";
import { browserOAuthClassification } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import {
  type NativeDriverInput,
  nativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "@opensesame/app-core/lib/native-connector-schema.js";
import {
  readNativeConnector,
  saveNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeApiRuntime } from "./native-api-runtime.js";
import { bindNativeCleanupRuntime } from "./native-cleanup-runtime.js";
import { bindNativeOAuthRuntime } from "./native-oauth-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

installNativeApiTests();
const googleDraft: NativeDriverInput = {
  providerId: "google",
  method: "oauth",
  displayName: "Existing Google",
  icon: "",
  parameters: { client_id: "public-native-client" },
  credentials: {},
  requestedScopes: {},
  targetIds: {},
};

async function previouslyAuthorizedGoogle() {
  const configured = await configureNativeBrowserOAuthConnector(googleDraft);
  return updateNativeConnector(
    configured.connectionId,
    {
      revision: configured.revision,
      fingerprint: configured.fingerprint,
    },
    browserOAuthClassification(configured.configuration),
    (record) => {
      const expiresAt = Date.now() + 3_600_000;
      const scopes = record.configuration.requestedScopes.user ?? [];
      record.privateState.grants.user = {
        providerId: "google",
        actor: "user",
        kind: "oauth",
        fingerprint: configured.fingerprint,
        accessToken: "private-google-token",
        clientId: "public-native-client",
        issuer: "https://accounts.google.com",
        targetId: "google-user",
        expiresAt,
        scopes,
      };
      record.privateState.verification = {
        fingerprint: configured.fingerprint,
        verifiedAt: 100,
        kind: "provider",
      };
      record.runtime = {
        ...emptyNativeRuntime(),
        verifiedAt: 100,
        identity: {
          id: "google-user",
          label: "Google account",
          kind: "account",
          assurance: "account-verified",
        },
        grants: [
          {
            actor: "user",
            label: "User",
            permissionState: "known",
            grantedScopes: scopes,
            expiresAt,
            needsReauth: false,
          },
        ],
      };
      return record;
    },
  );
}

it("keeps Google reads and provider revocation registered under strict isolation while refusing new popup consent before storage or script loading", async () => {
  vi.stubGlobal("crossOriginIsolated", true);
  const test = createTestContext({
    egressResponse: () =>
      Response.json({ sub: "google-user", name: "Google account" }),
  });
  const activation = createActivation(test.ctx, "connectors.external");
  try {
    bindNativeRuntime(test.ctx, activation);
    bindNativeOAuthRuntime(activation);
    bindNativeCleanupRuntime(activation);
    expect(nativeGoogleBrowserAvailable()).toBe(false);
    const saved = await previouslyAuthorizedGoogle();
    const driver = nativeConnectorDriver("oauth", "google");
    expect(driver.supports("google")).toBe(true);
    vi.mocked(kvSeams.kvSetDurable).mockClear();
    await expect(async () => driver.configure(googleDraft)).rejects.toThrow(
      "browser isolation policy",
    );
    if (!driver.authorize) throw new Error("Google consent was not registered");
    await expect(async () =>
      driver.authorize?.(saved.connectionId, "user"),
    ).rejects.toThrow("browser isolation policy");
    expect(kvSeams.kvSetDurable).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        'script[src="https://accounts.google.com/gsi/client"]',
      ),
    ).toBeNull();
    expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
    await driver.invoke(saved.connectionId, "provider.read", {});
    expect(test.egressCalls.map((call) => call.input)).toEqual([
      "https://openidconnect.googleapis.com/v1/userinfo",
    ]);
    const revoke = deviceProviderRevokers.google;
    if (!revoke) throw new Error("Google cleanup was not registered");
    await revoke(saved.connectionId);
    expect(test.egressCalls.map((call) => call.input)).toEqual([
      "https://openidconnect.googleapis.com/v1/userinfo",
      "https://oauth2.googleapis.com/revoke",
    ]);
    expect(readNativeConnector(saved.connectionId)).toBeNull();
  } finally {
    activation.dispose();
    vi.unstubAllGlobals();
  }
});

it("registers local API-key cleanup for a saved Resend connection even though its browser method is unavailable", async () => {
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  try {
    bindNativeRuntime(test.ctx, activation);
    bindNativeApiRuntime(activation);
    bindNativeCleanupRuntime(activation);
    const target = nativeApiTarget("resend", {});
    const fingerprint = await nativeApiFingerprint(target);
    const privateState = emptyNativePrivate();
    privateState.credentials = { api_key: "private-resend-key" };
    privateState.verification = {
      fingerprint,
      verifiedAt: 100,
      kind: "provider",
    };
    privateState.grants.app = {
      providerId: "resend",
      actor: "app",
      kind: "api-key",
      fingerprint,
      accessToken: "private-resend-key",
      targetId: "https://api.resend.com",
      scopes: null,
      expiresAt: null,
    };
    const saved = await saveNativeConnector(
      {
        connectionId: "previous-resend",
        configuration: {
          version: 1,
          providerId: "resend",
          method: "api-key",
          fingerprint,
          displayName: "Old Resend",
          icon: "",
          parameters: {},
          requestedScopes: {},
          targetIds: { api: "https://api.resend.com" },
        },
        runtime: {
          ...emptyNativeRuntime(),
          verifiedAt: 100,
          grants: [
            {
              actor: "app",
              label: "API key",
              permissionState: "provider-managed",
              grantedScopes: [],
              expiresAt: null,
              needsReauth: false,
            },
          ],
        },
        privateState,
      },
      target.classification,
    );
    expect(nativeConnectorDriver("api-key", "resend").supports("resend")).toBe(
      true,
    );
    const revoke = deviceProviderRevokers.resend;
    if (!revoke) throw new Error("Resend cleanup was not registered");
    await revoke(saved.connectionId);
    expect(readNativeConnector(saved.connectionId)).toBeNull();
    expect(test.egressCalls).toEqual([]);
  } finally {
    activation.dispose();
  }
});
