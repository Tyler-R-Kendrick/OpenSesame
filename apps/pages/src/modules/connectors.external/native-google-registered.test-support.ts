/** Independent Google-shaped TLS oracle; only this fixture remaps official hosts to loopback. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { registerNativeProviderCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { tlsFetch } from "@opensesame/app-core/lib/native-s3-backup.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  TailscaleNativeHTTPConfiguration,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { openBrowserNodeState } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { expect, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  bindNativeOAuthRuntime,
  nativeCallbackUrl,
} from "./native-oauth-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";
export const googleClient = "registered-web.apps.googleusercontent.com";
export const googleSecret = "operator_google_web:secret+sealed";
export const googleUser = {
  sub: "google-actor-42",
  email: "operator@example.com",
  email_verified: true,
};
const origins = [
  "https://oauth2.googleapis.com",
  "https://openidconnect.googleapis.com",
];
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "google-native-oauth-"));
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
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}
function validToken(
  form: URLSearchParams,
  headers: IncomingMessage["headers"],
  challenge: string,
): boolean {
  return (
    [...form.keys()].sort().join(",") ===
      "client_id,client_secret,code,code_verifier,grant_type,redirect_uri" &&
    form.get("client_id") === googleClient &&
    form.get("client_secret") === googleSecret &&
    form.get("code") === "independent-google-code" &&
    form.get("grant_type") === "authorization_code" &&
    form.get("redirect_uri") === nativeCallbackUrl() &&
    createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url") === challenge &&
    headers["content-type"]?.startsWith("application/x-www-form-urlencoded") ===
      true &&
    !headers.authorization
  );
}
function startOracle(tls: ReturnType<typeof certificate>) {
  const requests: { path: string; valid: boolean }[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  const state = { challenge: "", hold: false, deny: false };
  const server = createServer(tls, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const token = request.url === "/token" && request.method === "POST";
    const valid = token
      ? validToken(form, request.headers, state.challenge)
      : request.url === "/v1/userinfo" &&
        request.method === "GET" &&
        !chunks.length &&
        request.headers.authorization === "Bearer google-access-1";
    requests.push({
      path: request.url ?? "",
      valid: valid && !request.headers.cookie,
    });
    response.setHeader("content-type", "application/json");
    if (!valid || request.headers.cookie || state.deny) {
      response.writeHead(401);
      response.end('{"error":"invalid_client"}');
      return;
    }
    if (token)
      response.end(
        JSON.stringify({
          access_token: "google-access-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email",
        }),
      );
    else {
      if (state.hold) {
        entered.resolve();
        await release.promise;
      }
      response.end(JSON.stringify(googleUser));
    }
  });
  return { server, state, requests, entered, release };
}
async function bindNode(fetcher: typeof fetch) {
  const config = {
    hostname: "google-browser",
    controlURL: "https://controlplane.tailscale.com",
    nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
      version: 1,
      exitNodeID: "approved-google-exit",
      trustMode: "public",
      targets: origins.map((origin) => ({
        origin,
        prefixes: ["203.0.113.0/24"],
      })),
    }),
  };
  await openBrowserNodeState(config, vaultStore.getSnapshot().tomb, () => {
    if (vaultStore.getSnapshot().status !== "unlocked")
      throw new Error("Vault locked");
  });
  const lifetime = new AbortController();
  const capture = vi.fn((owner: AbortSignal) => {
    const signal = AbortSignal.any([owner, lifetime.signal]);
    const assertCurrent = () => signal.throwIfAborted();
    return {
      signal,
      assertCurrent,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        assertCurrent();
        const request = new Request(input, init);
        return fetcher(request, {
          signal: AbortSignal.any([signal, request.signal]),
        });
      },
    };
  });
  const node: TailscaleBrowserNode = {
    captureNativeHTTP: capture,
    snapshot: () => ({
      status: "connected",
      hostname: config.hostname,
      controlURL: config.controlURL,
      authURL: "",
      addresses: ["100.64.0.3"],
      peerCount: 1,
      failure: "",
    }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => lifetime.abort(),
    forget: async () => {},
    login() {},
    get: async () => {
      throw new Error("No peer fixture");
    },
  };
  return { lifetime, capture, release: bindTailscaleBrowserNode(node) };
}
export async function googleRegisteredFixture() {
  const local = await runtimeFixture();
  const tls = certificate();
  const oracle = startOracle(tls);
  await once(oracle.server.listen(0, "127.0.0.1"), "listening");
  const address = oracle.server.address();
  if (!address || !(address instanceof Object))
    throw new Error("Missing oracle address");
  const fetcher = tlsFetch(tls.cert);
  const destinations: string[] = [];
  const route: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(origins).toContain(url.origin);
    destinations.push(url.href);
    return fetcher(new URL(url.pathname, `https://127.0.0.1:${address.port}`), {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? await request.text() : undefined,
      signal: request.signal,
    });
  };
  const node = await bindNode(route);
  const test = createTestContext();
  const browserFetch = vi.fn(async () => {
    throw new Error("Unexpected direct/browser fallback");
  });
  const ctx = {
    ...test.ctx,
    egress: { ...test.ctx.egress, fetch: browserFetch },
  };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeOAuthRuntime(activation);
  const googleToken = vi.fn(async () => {
    throw new Error("GIS must remain blocked");
  });
  const releaseBrowser = bindNativeOAuthBrowserPort({
    redirectUri: nativeCallbackUrl(),
    navigate: () => {
      throw new Error("Unexpected navigation");
    },
    scrubCallback: () => {},
    googleToken,
    authorize: async (value) => {
      const url = new URL(value);
      expect(url.origin + url.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      expect(url.searchParams.has("resource")).toBe(false);
      expect(url.searchParams.has("client_secret")).toBe(false);
      expect(url.searchParams.get("client_id")).toBe(googleClient);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      oracle.state.challenge = url.searchParams.get("code_challenge") ?? "";
      return new URLSearchParams({
        native_state: url.searchParams.get("state") ?? "",
        native_code: "independent-google-code",
      }).toString();
    },
  });
  const driver = nativeConnectorDriver("oauth", "google");
  const releaseCleanup = registerNativeProviderCleanup(
    "google",
    driver.cleanup,
  );
  return {
    ...oracle,
    driver,
    node,
    googleToken,
    browserFetch,
    destinations,
    async close() {
      oracle.release.resolve();
      releaseCleanup();
      releaseBrowser();
      activation.dispose();
      node.lifetime.abort();
      node.release();
      oracle.server.closeAllConnections();
      await new Promise<void>((resolve) =>
        oracle.server.close(() => resolve()),
      );
      rmSync(tls.directory, { recursive: true, force: true });
      await local.close();
    },
  };
}
