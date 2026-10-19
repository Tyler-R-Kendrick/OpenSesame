/** Real owned TLS revocation oracle, not a hosted account or compiled PWA proof. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrowserOAuthDriver } from "@opensesame/app-core/lib/native-browser-oauth-connectors.js";
import { bindNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-binding.js";
import type { NativeDriverInput } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { registerNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeGrant } from "@opensesame/app-core/lib/native-connector-schema.js";
import { updateNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
  captureNativeProviderAuthority,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "@opensesame/app-core/lib/native-oauth-session.js";
import { oauthDraft } from "@opensesame/app-core/lib/native-oauth.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { tlsFetch } from "@opensesame/app-core/lib/test/native-s3-backup-fixtures.js";
import { z } from "zod";
import type { Activation } from "../activation.js";
import { bindNativeCleanupRuntime } from "./native-cleanup-runtime.js";

function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "oauth-cleanup-owner-"));
  const keyArgs = ["req", "-x509", "-newkey", "rsa:2048", "-nodes"];
  const identityArgs = ["-days", "2", "-subj", "/CN=localhost"];
  execFileSync(
    "openssl",
    [
      ...keyArgs,
      ...identityArgs,
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
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
type State = {
  hold: boolean;
  gate: boolean;
  entered: ReturnType<typeof deferred<void>>;
  closed: ReturnType<typeof deferred<void>>;
  prepared: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
  refreshRelease: ReturnType<typeof deferred<void>>;
  closedEarly: boolean;
  errors: string[];
  records: { path: string; method: string; epoch: string; body: string }[];
};
function protocolRequest(
  request: IncomingMessage,
  path: string,
  form: URLSearchParams,
) {
  const valid =
    request.method === "POST" &&
    form.get("client_id") === "public-browser-client";
  const revoke =
    path === "/oauth/revoke" &&
    [
      "owned-access",
      "owned-refresh",
      "rotated-access",
      "rotated-refresh",
    ].includes(form.get("token") ?? "");
  const refresh =
    path === "/oauth/token" &&
    form.get("grant_type") === "refresh_token" &&
    form.get("refresh_token") === "owned-refresh";
  return { valid, revoke, refresh };
}
async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  state: State,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  const path = request.url ?? "";
  state.records.push({
    path,
    method: request.method ?? "",
    epoch: String(request.headers["x-owned-epoch"] ?? ""),
    body,
  });
  if (path === "/api/v4/user" && request.method === "GET") {
    response.writeHead(503, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ error: "temporary" }));
    return;
  }
  const form = new URLSearchParams(body);
  const { valid, revoke, refresh } = protocolRequest(request, path, form);
  if (!valid || (!revoke && !refresh)) {
    state.errors.push("Unexpected cleanup protocol request");
    response.writeHead(400);
    response.end();
    return;
  }
  if (state.hold && revoke) {
    response.once("close", () => {
      state.closedEarly = !response.writableEnded;
      state.closed.resolve();
    });
    state.entered.resolve();
    return;
  }
  if (refresh) {
    state.entered.resolve();
    if (state.hold) await state.refreshRelease.promise;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        expires_in: 900,
        scope: "read_user",
      }),
    );
    return;
  }
  response.writeHead(200);
  response.end();
}
async function listener(state: State) {
  const tls = certificate();
  const server = createServer(tls, (request, response) => {
    void receive(request, response, state).catch(() => {
      state.errors.push("Owned TLS oracle failed");
      response.destroy();
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const real = tlsFetch(tls.cert);
  const send = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    epoch: number,
  ) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://gitlab.com")
      throw new Error("Unexpected cleanup authority");
    const headers = new Headers(request.headers);
    headers.set("x-owned-epoch", String(epoch));
    return real(`https://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body ? await request.arrayBuffer() : undefined,
      signal: request.signal,
    });
  };
  return { tls, server, send };
}
function activation(disposers: (() => void)[]): Activation {
  let disposed = false;
  const dispose = () => {
    disposed = true;
    for (const release of disposers.splice(0).reverse()) release();
  };
  return {
    register: () => {
      throw new Error("Unexpected registration");
    },
    onDispose: (release) => {
      disposers.push(release);
    },
    disposed: () => disposed,
    dispose,
    handle: () => ({ capability: "external-connectors", dispose }),
  };
}
function route(
  send: Awaited<ReturnType<typeof listener>>["send"],
  controller: AbortController,
  epoch: number,
): NativeProviderTransport {
  const assertCurrent = () => controller.signal.throwIfAborted();
  return {
    assertCurrent,
    signal: controller.signal,
    settleCredentialMutation: (input, init) => send(input, init, epoch),
    fetch: (input, init) => {
      assertCurrent();
      return send(
        input,
        {
          ...init,
          signal: AbortSignal.any([
            controller.signal,
            ...(input instanceof Request ? [input.signal] : []),
            ...(init?.signal ? [init.signal] : []),
          ]),
        },
        epoch,
      );
    },
  };
}
async function seed(
  driver: ReturnType<typeof createNativeBrowserOAuthDriver>,
  kind: "revoke" | "configure" = "revoke",
  input: NativeDriverInput = oauthDraft(),
) {
  const saved = await driver.configure(input);
  const record = requireNativeOAuthRecord(saved.connectionId);
  const grant: NativeGrant = {
    providerId: "gitlab",
    actor: "user",
    kind: "oauth",
    fingerprint: record.configuration.fingerprint,
    targetId: "gitlab",
    issuer: "https://gitlab.com",
    endpoint: "https://gitlab.com/oauth/token",
    clientId: "public-browser-client",
    accessToken: "owned-access",
    refreshToken: "owned-refresh",
    expiresAt: Date.now() + 900000,
    scopes: ["read_user"],
  };
  await updateNativeConnector(
    saved.connectionId,
    nativeOAuthGuard(record),
    driver.cleanup.classification(record.configuration),
    (current) => {
      current.privateState.recovery = [
        {
          id: "owned-obligation",
          kind,
          providerId: "gitlab",
          actor: "user",
          fingerprint: grant.fingerprint,
          targetId: "gitlab",
          grant,
        },
      ];
      return current;
    },
  );
  const pending = {
    providerId: "gitlab",
    actor: "user",
    fingerprint: grant.fingerprint,
    targetId: "gitlab",
    issuer: "https://gitlab.com",
    endpoint: "https://gitlab.com/oauth/token",
    clientId: "public-browser-client",
    state: "a".repeat(32),
    verifier: "v".repeat(43),
    redirectUri: "https://operator.example/auth/native-connector.html",
    createdAt: Date.now(),
    expiresAt: Date.now() + 900000,
    scopes: ["read_user"],
  };
  return { id: saved.connectionId, grant, pending };
}
function gatedDriver(
  driver: ReturnType<typeof createNativeBrowserOAuthDriver>,
  state: State,
) {
  const prepared = driver.cleanup.prepare;
  return {
    ...driver,
    cleanup: {
      ...driver.cleanup,
      prepare: async (id: string, original?: NativeProviderTransport) => {
        state.prepared.resolve();
        if (state.gate) await state.release.promise;
        if (original) await prepared?.(id, original);
        else await prepared?.(id);
      },
    },
  };
}
export async function cleanupOwnedFixture(
  createDriver: (
    authority: ReturnType<typeof captureNativeProviderAuthority>,
  ) => ReturnType<
    typeof createNativeBrowserOAuthDriver
  > = createNativeBrowserOAuthDriver,
) {
  const local = await runtimeFixture();
  const state: State = {
    hold: false,
    gate: false,
    entered: deferred<void>(),
    closed: deferred<void>(),
    prepared: deferred<void>(),
    release: deferred<void>(),
    refreshRelease: deferred<void>(),
    closedEarly: false,
    errors: [],
    records: [],
  };
  const { tls, server, send } = await listener(state);
  const disposers: (() => void)[] = [];
  const controllers: AbortController[] = [];
  let epoch = 0;
  let captures = 0;
  let active = new AbortController();
  const base = (): NativeProviderTransport => {
    const signal = active.signal;
    return {
      signal,
      assertCurrent: () => signal.throwIfAborted(),
      fetch: async () => {
        throw new Error("Uncaptured cleanup Fetch forbidden");
      },
      capture: () => {
        captures++;
        const controller = new AbortController();
        controllers.push(controller);
        return route(send, controller, epoch);
      },
    };
  };
  disposers.push(
    bindNativeProviderTransport(base()),
    bindNativeOAuthBrowserPort({
      redirectUri: "https://operator.example/auth/native-connector.html",
      navigate: () => {},
      scrubCallback: () => {},
    }),
  );
  const authority = captureNativeProviderAuthority();
  const driver = gatedDriver(
    bindNativeConnectorDriver(createDriver(authority), authority),
    state,
  );
  disposers.push(registerNativeConnectorDriver("oauth", driver));
  const owner = activation(disposers);
  bindNativeCleanupRuntime(owner);
  return {
    state,
    driver,
    authority,
    get captures() {
      return captures;
    },
    seed: (kind?: "revoke" | "configure", input?: NativeDriverInput) =>
      seed(driver, kind, input),
    replaceRoute() {
      epoch++;
      for (const controller of controllers) controller.abort();
    },
    replaceActivation() {
      active.abort();
      epoch++;
      for (const controller of controllers) controller.abort();
      active = new AbortController();
      disposers.push(bindNativeProviderTransport(base()));
    },
    async close() {
      state.release.resolve();
      state.refreshRelease.resolve();
      owner.dispose();
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tls.directory, { recursive: true, force: true });
      await local.close();
    },
  };
}
