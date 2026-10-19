/** @vitest-environment jsdom */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeAuthChannel } from "@opensesame/app-core/browser/native-auth-message.js";
import { nativeBrowserOAuthCleanup } from "@opensesame/app-core/lib/native-browser-oauth-cleanup.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { registerNativeProviderCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { loadNativeConnectorRecord } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  bindNativeOAuthBrowserPort,
  nativeOAuthBrowserPort,
} from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { nativeOAuthClientFixture } from "@opensesame/app-core/lib/native-oauth-client.test-support.js";
import { createNativeOAuthResourceDriver } from "@opensesame/app-core/lib/native-oauth-resource-driver.js";
import { tlsFetch } from "@opensesame/app-core/lib/native-s3-backup.test-support.js";
import { refreshNativeTwitchAuthorization } from "@opensesame/app-core/lib/native-twitch-device-refresh.js";
import {
  saveValidationFixture,
  validationAccess,
  validationClient,
  validationReply,
} from "@opensesame/app-core/lib/native-twitch-session-validation.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  bindNativeOAuthRuntime,
  nativeCallbackUrl,
} from "./native-oauth-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

const closes: (() => void | Promise<void>)[] = [];
const operations: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.allSettled(operations.splice(0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function actualPopup(transport: NativeProviderTransport) {
  const popup = {
    opener: null,
    close: vi.fn(),
    location: { replace: vi.fn<(url: string) => void>() },
  };
  const open = vi.fn(() => popup);
  const originalWindow = window;
  vi.stubGlobal("window", {
    document: originalWindow.document,
    postMessage: originalWindow.postMessage.bind(originalWindow),
    addEventListener: originalWindow.addEventListener.bind(originalWindow),
    removeEventListener:
      originalWindow.removeEventListener.bind(originalWindow),
    location: new URL("https://operator.example"),
    open,
    history: { replaceState: vi.fn() },
  });
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  bindNativeRuntime(test.ctx, activation);
  activation.onDispose(bindNativeProviderTransport(transport));
  bindNativeOAuthRuntime(activation);
  closes.push(activation.dispose);
  const browser = nativeOAuthBrowserPort();
  expect(() => browser.captureAuthorizationGuard?.()).toThrow(
    "fresh provider sign-in",
  );
  return { popup, open, browser, activation };
}
async function resource() {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closes.push(f.close);
  f.input.providerId = "box";
  const carrier: NativeProviderTransport = {
    ...f.owner.transport,
    supportsNativeOrigin: (origin) =>
      origin === new URL(f.state.resource).origin,
  };
  const flow = actualPopup(carrier);
  f.state.redirectUri = nativeCallbackUrl();
  const driver = nativeConnectorDriver("oauth", "box");
  closes.push(registerNativeProviderCleanup("box", driver.cleanup));
  return { ...f, ...flow, driver, carrier };
}
it("uses the real reserved popup for consent, then configures, verifies, reads and forgets saved TLS resources without another popup", async () => {
  const f = await resource();
  const saved = await f.driver.configure(f.input);
  expect(f.requests).toEqual([]);
  expect(f.open).not.toHaveBeenCalled();
  const release = f.browser.prepareAuthorization?.();
  closes.push(() => release?.());
  const authorized = f.driver.authorize?.(saved.connectionId);
  operations.push(Promise.resolve(authorized));
  await vi.waitFor(() =>
    expect(f.popup.location.replace).toHaveBeenCalledOnce(),
  );
  const target = f.popup.location.replace.mock.calls[0]?.[0];
  if (!target) throw new Error("Missing actual consent navigation");
  const url = new URL(target);
  f.state.challenge = url.searchParams.get("code_challenge") ?? "";
  f.state.scope = url.searchParams.get("scope") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const channel = new BroadcastChannel(await nativeAuthChannel(state));
  closes.push(() => channel.close());
  channel.postMessage({
    kind: "authorization-code",
    redirectUri: f.state.redirectUri,
    receipt: "b".repeat(64),
    state,
    code: "one-use-code",
  });
  await authorized;
  release?.();
  expect(() => f.browser.captureAuthorizationGuard?.()).toThrow(
    "fresh provider sign-in",
  );
  expect((await f.driver.verify(saved.connectionId)).status).toBe("connected");
  const result = await f.driver.invoke(
    saved.connectionId,
    "provider.resource.read",
    {},
  );
  expect(JSON.parse(result.items[0]?.secretValue ?? "null")).toEqual({
    projects: [{ id: "project-42", name: "Actual configured project" }],
  });
  const spare = await f.driver.configure(f.input);
  const targetId = spare.configuration.parameters.resource;
  if (!targetId) throw new Error("Missing saved resource target");
  await f.driver.cleanup.prepare?.(spare.connectionId);
  expect(
    await f.driver.cleanup.cleanup(
      {
        id: "local-only",
        kind: "configure",
        providerId: "box",
        actor: "user",
        fingerprint: spare.configuration.fingerprint,
        targetId,
      },
      {
        connectionId: spare.connectionId,
        configuration: spare.configuration,
        transport: f.owner.transport,
        persistGrantRotation: async () => {},
      },
    ),
  ).toBe("local-credential-forgotten");
  expect(f.requests.map((row) => row.path)).toEqual([
    "/token",
    "/resource",
    "/resource",
    "/resource",
  ]);
  expect(
    f.requests
      .slice(1)
      .every((row) => row.authorization === "Bearer issued-access-1"),
  ).toBe(true);
  expect(f.open).toHaveBeenCalledOnce();
  const count = f.requests.length;
  f.activation.dispose();
  await expect(f.driver.verify(saved.connectionId)).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
});
it("captures consent before held custody and never adopts a replacement reservation", async () => {
  const f = await resource();
  const saved = await f.driver.configure(f.input);
  const held = deferred<void>();
  const close = vi.fn();
  const capture = vi.fn(async () => {
    await held.promise;
    return {
      ...f.owner,
      transport: f.carrier,
      redirectUri: f.state.redirectUri,
      close,
    };
  });
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture,
  });
  await expect(driver.authorize?.(saved.connectionId)).rejects.toThrow(
    "fresh provider sign-in",
  );
  expect(capture).not.toHaveBeenCalled();
  const releaseA = f.browser.prepareAuthorization?.();
  const pending = driver.authorize?.(saved.connectionId);
  const rejected = expect(pending).rejects.toThrow();
  operations.push(rejected);
  expect(capture).toHaveBeenCalledOnce();
  releaseA?.();
  const releaseB = f.browser.prepareAuthorization?.();
  closes.push(() => releaseB?.());
  const currentB = f.browser.captureAuthorizationGuard?.();
  held.resolve();
  await rejected;
  expect(() => currentB?.()).not.toThrow();
  expect(close).toHaveBeenCalledOnce();
  expect(f.requests).toEqual([]);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants,
  ).toEqual({});
  expect(f.popup.location.replace).not.toHaveBeenCalled();
});
it("does not adopt a later popup port when the original consent port has no capture guard", async () => {
  const f = await resource();
  const saved = await f.driver.configure(f.input);
  const original = vi.fn(async () => {
    throw new Error("Original legacy consent refused");
  });
  closes.push(
    bindNativeOAuthBrowserPort({
      redirectUri: f.state.redirectUri,
      navigate: () => {},
      scrubCallback: () => {},
      authorize: original,
    }),
  );
  const held = deferred<void>();
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture: async () => {
      await held.promise;
      return { ...f.owner, redirectUri: f.state.redirectUri, close: () => {} };
    },
  });
  const pending = driver.authorize?.(saved.connectionId);
  const rejected = expect(pending).rejects.toThrow(
    "Original legacy consent refused",
  );
  operations.push(rejected);
  closes.push(bindNativeOAuthBrowserPort(f.browser));
  held.resolve();
  await rejected;
  expect(original).toHaveBeenCalledOnce();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.requests).toEqual([]);
});
async function twitchTls() {
  const directory = mkdtempSync(join(tmpdir(), "saved-twitch-tls-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  const requests: { path: string; authorization: string; body: string }[] = [];
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const path = request.url ?? "";
      const authorization = request.headers.authorization ?? "";
      requests.push({ path, authorization, body });
      response.setHeader("content-type", "application/json");
      if (path === "/oauth2/token")
        response.end(
          JSON.stringify({
            access_token: validationAccess,
            refresh_token: "rotated-refresh",
            token_type: "bearer",
            expires_in: 14400,
            scope: validationReply.scopes,
          }),
        );
      else if (path === "/oauth2/validate")
        response.end(JSON.stringify(validationReply));
      else if (path === "/helix/users")
        response.end(
          JSON.stringify({
            data: [
              { id: "12345", login: "engineer", display_name: "Engineer" },
            ],
          }),
        );
      else {
        response.writeHead(404);
        response.end();
      }
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closes.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const secure = tlsFetch(readFileSync(cert));
  const controller = new AbortController();
  const fetchOriginal: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (!["https://id.twitch.tv", "https://api.twitch.tv"].includes(url.origin))
      throw new Error("Unexpected Twitch origin");
    return secure(`https://127.0.0.1:${port}${url.pathname}`, {
      ...init,
      signal: controller.signal,
    });
  };
  return {
    requests,
    controller,
    transport: {
      fetch: fetchOriginal,
      settleCredentialMutation: fetchOriginal,
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
    },
  };
}
it("rotates the saved Twitch pair over actual TLS without reserving a popup and retains the original carrier fence", async () => {
  const local = await runtimeFixture();
  closes.push(local.close);
  const id = await saveValidationFixture();
  const original = loadNativeConnectorRecord(id);
  if (!original) throw new Error("Missing saved fixture");
  const tls = await twitchTls();
  const f = actualPopup(tls.transport);
  closes.push(
    registerNativeProviderCleanup("twitch", nativeBrowserOAuthCleanup),
  );
  // The fixture reuses its access token, so there is no old-access revocation operation.
  await refreshNativeTwitchAuthorization(original, tls.transport);
  expect(
    loadNativeConnectorRecord(id)?.privateState.grants.user?.refreshToken,
  ).toBe("rotated-refresh");
  expect(tls.requests.map((row) => row.path)).toEqual([
    "/oauth2/token",
    "/oauth2/validate",
    "/helix/users",
  ]);
  const body = new URLSearchParams(tls.requests[0]?.body);
  expect(body.get("grant_type")).toBe("refresh_token");
  expect(body.get("refresh_token")).toBe(
    "test-issued-validation-refresh-token",
  );
  expect(body.get("client_id")).toBe(validationClient);
  expect(body.has("client_secret")).toBe(false);
  expect(
    tls.requests
      .filter((row) => row.path === "/oauth2/validate")
      .every((row) => row.authorization === `OAuth ${validationAccess}`),
  ).toBe(true);
  expect(f.open).not.toHaveBeenCalled();
  expect(() => f.browser.captureAuthorizationGuard?.()).toThrow(
    "fresh provider sign-in",
  );
  const before = tls.requests.length;
  tls.controller.abort();
  await expect(
    refreshNativeTwitchAuthorization(original, tls.transport),
  ).rejects.toThrow();
  expect(tls.requests).toHaveLength(before);
});
