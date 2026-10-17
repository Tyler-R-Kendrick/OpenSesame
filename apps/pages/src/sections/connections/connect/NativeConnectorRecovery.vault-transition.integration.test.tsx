/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://selfhost.example/"} */
import {
  readDeviceRows,
  subscribeDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
} from "@opensesame/app-core/lib/native-browser-oauth-connectors.js";
import {
  browserOAuthClassification,
  requiredBrowserOAuthProfile,
} from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import {
  claimNativeOAuthPending,
  nativeOAuthGuard,
} from "@opensesame/app-core/lib/native-oauth-session.js";
import {
  attestNativeVaultRevocation,
  nativeVaultRevocationInstructions,
} from "@opensesame/app-core/lib/native-vault-attestation.js";
import { completeNativeVaultOidc } from "@opensesame/app-core/lib/native-vault-auth.js";
import * as vaultIntent from "@opensesame/app-core/lib/native-vault-intent.js";
import { readNativeVaultInstance } from "@opensesame/app-core/lib/native-vault-operations.js";
import {
  authorizeNativeVault,
  configureNativeVault,
  nativeVaultClassification,
} from "@opensesame/app-core/lib/native-vault-session.js";
import { act, render, screen } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { expect, it, vi } from "vitest";
import { NativeConnectorRecovery } from "./NativeConnectorRecovery.js";
import { nativeConnectorController } from "./native-connector-controller.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

installConnectorIntegration();
const redirectUri = "https://selfhost.example/auth/native-connector.html";
const state = "vault-recovery-transition-state-0123456789";
const nonce = "vault-recovery-transition-nonce";
const token = "hvs.synthetic-recovery-transition-token";
const bindingError =
  "Provider revocation confirmation belongs to another Vault connection";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function record(id: string) {
  const current = loadNativeConnectorRecord(id);
  if (!current) throw new Error("Missing real connector record");
  return current;
}

function RecoverySubscriber({
  controller,
}: { controller: ReturnType<typeof nativeConnectorController> }) {
  const [, refresh] = useState(0);
  useLayoutEffect(
    () => subscribeDeviceRows(() => refresh((version) => version + 1)),
    [],
  );
  const view = controller.load();
  if (!view) throw new Error("Missing real connector view");
  return (
    <NativeConnectorRecovery
      view={view}
      controller={controller}
      disabled
      onChanged={() => refresh((version) => version + 1)}
      onFlash={vi.fn()}
    />
  );
}

function holdPrepare() {
  const prepare = vaultIntent.prepareVaultExchange;
  const entered = deferred();
  const resume = deferred();
  vi.spyOn(vaultIntent, "prepareVaultExchange").mockImplementationOnce(
    async (...args) => {
      entered.resolve();
      await resume.promise;
      return prepare(...args);
    },
  );
  return { entered: entered.promise, resume: resume.resolve };
}

function vaultAuthority() {
  const actual = connectorIntegration();
  const exchangeEntered = deferred();
  const exchangeResume = deferred();
  actual.route.respond = async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/oidc/auth_url")) {
      const authorization = new URL("https://issuer.example.org/authorize");
      authorization.search = new URLSearchParams({
        state,
        nonce,
        redirect_uri: redirectUri,
        response_type: "code",
      }).toString();
      return Response.json({ data: { auth_url: authorization.href } });
    }
    if (url.pathname.endsWith("/oidc/callback")) {
      expect(url.searchParams.get("state")).toBe(state);
      expect(url.searchParams.get("nonce")).toBe(nonce);
      expect(url.searchParams.get("code")).toBe("approved-fixture-code");
      exchangeEntered.resolve();
      await exchangeResume.promise;
      return Response.json({
        auth: { client_token: token, lease_duration: 300 },
      });
    }
    expect(request.headers.get("X-Vault-Token")).toBe(token);
    if (url.pathname.endsWith("/lookup-self"))
      return Response.json({
        data: {
          entity_id: "fixture-identity",
          display_name: "fixture-reader",
          policies: ["browser-read"],
          ttl: 300,
          renewable: true,
        },
      });
    if (url.pathname === "/v1/secret/data/app/config")
      return Response.json({
        data: {
          data: { setting: "fixture-KV-value" },
          metadata: { version: 2 },
        },
      });
    throw new Error("Unexpected typed Vault fixture request");
  };
  return {
    ...actual,
    exchangeEntered: exchangeEntered.promise,
    resumeExchange: exchangeResume.resolve,
  };
}

async function assertConfigureStage(
  id: string,
  controller: ReturnType<typeof nativeConnectorController>,
  requests: Request[],
) {
  const entry = record(id).privateState.recovery[0];
  if (!entry) throw new Error("Missing claimed real recovery");
  expect(entry.kind).toBe("configure");
  expect(
    screen.getByRole("heading", { name: "Provider cleanup" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry provider cleanup required" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("img", {
      name: "Retry provider cleanup before changing or removing this connection.",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("link", {
      name: "Open provider revocation instructions",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Confirm provider revocation" }),
  ).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(controller.revocationInstructions?.(entry.id)).toBeNull();
  expect(() => nativeVaultRevocationInstructions(id, entry.id)).toThrow(
    bindingError,
  );
  await expect(controller.confirmRevocation?.(entry.id)).rejects.toThrow(
    bindingError,
  );
  expect(record(id).privateState.recovery).toHaveLength(1);
  expect(readNativeConnector(id)?.verifiedAt).toBeNull();
  expect(
    requests.filter((request) =>
      new URL(request.url).pathname.endsWith("/oidc/callback"),
    ),
  ).toHaveLength(0);
}

async function assertRevokeStage(
  id: string,
  providerId: "vault" | "openbao",
  controller: ReturnType<typeof nativeConnectorController>,
) {
  const entry = record(id).privateState.recovery[0];
  if (!entry) throw new Error("Missing prepared real recovery");
  expect(entry.kind).toBe("revoke");
  expect(controller.revocationInstructions?.(entry.id)).toMatchObject({
    canConfirm: false,
    url: expect.stringContaining(
      providerId === "vault" ? "developer.hashicorp.com" : "openbao.org",
    ),
  });
  expect(
    screen.getByRole("link", { name: "Open provider revocation instructions" }),
  ).toBeTruthy();
  expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Confirm provider revocation" }),
  ).toHaveProperty("disabled", true);
  await expect(attestNativeVaultRevocation(id, entry.id)).rejects.toThrow(
    "still pending",
  );
  expect(record(id).privateState.recovery).toHaveLength(1);
}

it.each(["vault", "openbao"] as const)(
  "%s keeps its real configure recovery visible and continues through prepared revocation to verified KV access",
  async (providerId) => {
    const actual = vaultAuthority();
    const id = await configureNativeVault({
      providerId,
      endpoint: `https://${providerId}.example.org`,
      namespace: "engineering",
      authMount: "oidc",
      role: "browser-read",
    });
    await authorizeNativeVault(id, redirectUri);
    const controller = nativeConnectorController(
      { id: providerId, refused: false },
      id,
    );
    render(<RecoverySubscriber controller={controller} />);
    const prepare = holdPrepare();
    const completion = completeNativeVaultOidc(id, {
      state,
      code: "approved-fixture-code",
    });
    const settled = Promise.allSettled([completion]);
    try {
      await act(async () => prepare.entered);
      await assertConfigureStage(id, controller, actual.requests);
      await act(async () => {
        prepare.resume();
        await actual.exchangeEntered;
      });
      await assertRevokeStage(id, providerId, controller);
      await act(async () => {
        actual.resumeExchange();
        await completion;
      });
      expect(controller.load()).toMatchObject({
        status: "connected",
        identity: { id: "fixture-identity" },
        recovery: [],
      });
      expect(record(id).privateState.grants.user?.accessToken).toBe(token);
      expect(JSON.stringify(readDeviceRows())).not.toContain(token);
      expect(JSON.stringify(controller.load())).not.toContain(token);
      expect([...actual.disk.files.values()].join()).not.toContain(token);
      expect(
        screen.queryByRole("heading", { name: "Provider cleanup" }),
      ).toBeNull();
      expect(
        await readNativeVaultInstance(id, {
          mount: "secret",
          path: "app/config",
        }),
      ).toEqual({
        data: { setting: "fixture-KV-value" },
        metadata: { version: 2 },
      });
      expect((await settled)[0]?.status).toBe("fulfilled");
    } finally {
      prepare.resume();
      actual.resumeExchange();
      await settled;
    }
  },
);

it("preserves actual generic OAuth configure recovery instructions", async () => {
  connectorIntegration();
  const profile = requiredBrowserOAuthProfile("gitlab");
  const configured = await configureNativeBrowserOAuthConnector({
    providerId: "gitlab",
    method: "oauth",
    displayName: "GitLab recovery fixture",
    parameters: { client_id: "public-browser-fixture-client" },
    credentials: {},
    requestedScopes: { user: [...profile.requiredScopes] },
    targetIds: {},
  });
  await beginNativeBrowserAuthorization(configured.connectionId);
  const pending = record(configured.connectionId).privateState.pending.user;
  if (!pending) throw new Error("Missing actual generic OAuth pending state");
  const claim = await claimNativeOAuthPending(
    new URLSearchParams({
      native_state: pending.state,
      native_code: "fixture-code",
    }).toString(),
    browserOAuthClassification(configured.configuration),
  );
  expect(claim.obligation.kind).toBe("configure");
  const controller = nativeConnectorController(
    { id: "gitlab", refused: false },
    configured.connectionId,
  );
  controller.load();
  expect(
    controller.revocationInstructions?.(claim.obligation.id),
  ).toMatchObject({
    url: "https://gitlab.com/-/user_settings/applications",
    canConfirm: false,
  });
  render(<RecoverySubscriber controller={controller} />);
  expect(
    screen
      .getByRole("link", { name: "Open provider revocation instructions" })
      .getAttribute("href"),
  ).toBe("https://gitlab.com/-/user_settings/applications");
  expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  expect(record(configured.connectionId).privateState.recovery).toHaveLength(1);
});

it.each(["actor", "fingerprint", "namespace"] as const)(
  "retains strict Vault revoke validation for a mismatched %s",
  async (field) => {
    vaultAuthority();
    const id = await configureNativeVault({
      providerId: "vault",
      endpoint: "https://vault.example.org",
      namespace: "engineering",
      authMount: "oidc",
      role: "browser-read",
    });
    await authorizeNativeVault(id, redirectUri);
    const claim = await claimNativeOAuthPending(
      new URLSearchParams({
        native_state: state,
        native_code: "fixture-code",
      }).toString(),
      nativeVaultClassification,
    );
    await vaultIntent.prepareVaultExchange(id, claim.obligation.id);
    await updateNativeConnector(
      id,
      nativeOAuthGuard(record(id)),
      nativeVaultClassification,
      (current) => {
        const entry = current.privateState.recovery[0];
        if (!entry || entry.kind !== "revoke")
          throw new Error("Missing actual prepared recovery");
        if (field === "actor") entry.actor = "other-actor";
        if (field === "fingerprint") entry.fingerprint = "f".repeat(64);
        if (field === "namespace") entry.credentials = { namespace: "other" };
        return current;
      },
    );
    const controller = nativeConnectorController(
      { id: "vault", refused: false },
      id,
    );
    controller.load();
    expect(() =>
      controller.revocationInstructions?.(claim.obligation.id),
    ).toThrow(bindingError);
    expect(() =>
      nativeVaultRevocationInstructions(id, claim.obligation.id),
    ).toThrow(bindingError);
    await expect(
      attestNativeVaultRevocation(id, claim.obligation.id),
    ).rejects.toThrow(bindingError);
    expect(record(id).privateState.recovery).toHaveLength(1);
    expect(record(id).privateState.recovery[0]?.id).toBe(claim.obligation.id);
  },
);
