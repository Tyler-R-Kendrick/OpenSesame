import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Independent HTTPS protocol authority; the finite captured route is a test port, not WASM proof. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { createNativeBrowserOAuthDriver } from "./native-browser-oauth-connectors.js";
import {
  browserOAuthClassification,
  browserOAuthEndpoints,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { updateNativeConnector } from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
  captureNativeProviderAuthority,
} from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { oauthDraft } from "./native-oauth.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "./secret-backends/runtime.test-support.js";
import { tlsFetch } from "./test/native-s3-backup-fixtures.js";

const callback = "https://selfhost.example/auth/native-connector.html";
const token = "owned-public-oauth-issued-access";
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "public-oauth-owner-"));
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
  hold: string;
  entered: ReturnType<typeof deferred<void>>;
  closed: ReturnType<typeof deferred<void>>;
  challenge: string;
  closedEarly: boolean;
  records: { origin: string; method: string; path: string }[];
  errors: string[];
  replies: Map<string, BoundaryValue>;
};
function reply(response: ServerResponse, body: BoundaryValue) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
function identityReply(path: string) {
  if (path === "/domains")
    return { data: [{ id: "domain-1", name: "owned.example" }] };
  if (path === "/api/v1/user") return { id: 7, login: "owned-user" };
  if (path === "/api/v1/user/repos?limit=100")
    return [
      {
        id: 42,
        full_name: "owned/project",
        html_url: "https://codeberg.org/owned/project",
      },
    ];
  return null;
}
async function tokenResponse(
  request: IncomingMessage,
  response: ServerResponse,
  state: State,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const form = new URLSearchParams(Buffer.concat(chunks).toString());
  if (
    form.get("grant_type") !== "authorization_code" ||
    form.get("client_id") !==
      "https://selfhost.example/auth/native-client.json" ||
    form.get("redirect_uri") !== callback ||
    form.get("code") !== "owned-code" ||
    form.has("client_secret") ||
    createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url") !== state.challenge
  ) {
    state.errors.push("Unexpected public token exchange");
    response.writeHead(400);
    reply(response, { error: "invalid_grant" });
    return;
  }
  reply(response, {
    access_token: token,
    token_type: "Bearer",
    scope: "full_access",
    expires_in: 900,
  });
  return;
}
async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  state: State,
) {
  const path = request.url ?? "";
  const origin = String(request.headers["x-owned-origin"] ?? "");
  state.records.push({ origin, method: request.method ?? "", path });
  const route = `${request.method} ${origin} ${path}`;
  if (state.hold === path) {
    response.once("close", () => {
      state.closedEarly = !response.writableEnded;
      state.closed.resolve();
    });
    state.entered.resolve();
    return;
  }
  if (
    route ===
    "GET https://api.resend.com /.well-known/oauth-authorization-server"
  ) {
    reply(response, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    return;
  }
  if (route === "GET https://selfhost.example /auth/native-client.json") {
    reply(response, {
      client_id: "https://selfhost.example/auth/native-client.json",
      client_name: "OpenSesame",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    return;
  }
  if (route === "POST https://api.resend.com /oauth/token") {
    await tokenResponse(request, response, state);
    return;
  }
  const body = state.replies.get(path) ?? identityReply(path);
  if (
    request.method === "GET" &&
    body &&
    request.headers.authorization === `Bearer ${token}` &&
    [
      "https://api.resend.com",
      "https://codeberg.org",
      "https://discord.com",
    ].includes(origin)
  ) {
    reply(response, body);
    return;
  }
  state.errors.push("Unexpected owned provider request");
  response.writeHead(405);
  reply(response, { error: "unsupported" });
}
function routePort(
  send: typeof fetch,
  controller: AbortController,
  current: () => boolean,
): NativeProviderTransport {
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    if (!current()) throw new Error("Original native route replaced");
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    assertCurrent();
    const signals = [
      controller.signal,
      ...(input instanceof Request ? [input.signal] : []),
      ...(init?.signal ? [init.signal] : []),
    ];
    return send(input, { ...init, signal: AbortSignal.any(signals) });
  };
  return {
    signal: controller.signal,
    assertCurrent,
    fetch,
    settleCredentialMutation: send,
    supportsNativeOrigin: (origin) => {
      assertCurrent();
      return [
        "https://api.resend.com",
        "https://codeberg.org",
        "https://discord.com",
      ].includes(origin);
    },
  };
}
async function ownedListener(state: State) {
  const tls = certificate();

  const server = createServer(tls, (request, response) => {
    void receive(request, response, state).catch(() => {
      state.errors.push("Owned protocol fixture failed");
      response.destroy();
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  const real = tlsFetch(tls.cert);
  const send: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("x-owned-origin", url.origin);
    return real(origin + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.body ? await request.arrayBuffer() : undefined,
      signal: request.signal,
    });
  };
  return { tls, server, send };
}
async function seedConfigured(
  driver: ReturnType<typeof createNativeBrowserOAuthDriver>,
  draft: ReturnType<typeof oauthDraft>,
  id: string,
) {
  const view = await driver.configure(draft);
  const record = requireNativeOAuthRecord(view.connectionId);
  const profile = requiredBrowserOAuthProfile(id);
  const endpoints = browserOAuthEndpoints(profile, record.configuration);
  const saved = await updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      current.privateState.grants.user = {
        kind: "oauth",
        providerId: id,
        actor: "user",
        fingerprint: current.configuration.fingerprint,
        issuer: endpoints.issuer,
        endpoint: endpoints.token,
        clientId: current.configuration.clientId,
        accessToken: token,
        expiresAt: Date.now() + 900000,
        scopes: current.configuration.requestedScopes.user ?? [],
      };
      current.runtime.grants = [
        {
          actor: "user",
          label: "Owned user",
          permissionState: "known",
          grantedScopes: current.configuration.requestedScopes.user ?? [],
          expiresAt: current.privateState.grants.user.expiresAt,
          needsReauth: false,
        },
      ];
      current.runtime.verifiedAt = Date.now();
      current.privateState.verification = {
        fingerprint: current.configuration.fingerprint,
        verifiedAt: current.runtime.verifiedAt,
        kind: "provider",
      };
      return current;
    },
  );
  return saved;
}
export async function publicOAuthOwnedFixture(id = "resend") {
  const local = await runtimeFixture();
  const state: State = {
    hold: "",
    entered: deferred<void>(),
    closed: deferred<void>(),
    challenge: "",
    closedEarly: false,
    records: [],
    errors: [],
    replies: new Map(),
  };
  const { tls, server, send } = await ownedListener(state);
  let epoch = 0;
  let captures = 0;
  let activation = new AbortController();
  const controllers: AbortController[] = [];
  const base = (): NativeProviderTransport => ({
    signal: activation.signal,
    assertCurrent: () => activation.signal.throwIfAborted(),
    fetch: async () => {
      throw new Error("Uncaptured browser Fetch forbidden");
    },
    capture: () => {
      captures++;
      const captured = epoch;
      const controller = new AbortController();
      controllers.push(controller);
      return routePort(send, controller, () => epoch === captured);
    },
  });
  const releases = [bindNativeProviderTransport(base())];
  let onConsent: (() => void) | undefined;
  releases.push(
    bindNativeOAuthBrowserPort({
      redirectUri: callback,
      navigate: () => {
        throw new Error("Unexpected full-page consent navigation");
      },
      scrubCallback: () => {},
      authorize: async (url, options) => {
        const parsed = new URL(url);
        state.challenge = parsed.searchParams.get("code_challenge") ?? "";
        onConsent?.();
        options.signal?.throwIfAborted();
        return new URLSearchParams({
          native_state: options.state,
          native_code: "owned-code",
        }).toString();
      },
    }),
  );
  const authority = captureNativeProviderAuthority();
  const driver = createNativeBrowserOAuthDriver(authority);
  const draft = oauthDraft(id);
  if (id === "resend") draft.parameters = {};
  return {
    driver,
    draft,
    state,
    authority,
    get captures() {
      return captures;
    },
    set onConsent(value: (() => void) | undefined) {
      onConsent = value;
    },
    replaceRoute() {
      epoch++;
      for (const controller of controllers) controller.abort();
    },
    replaceActivation() {
      activation.abort();
      epoch++;
      for (const controller of controllers) controller.abort();
      activation = new AbortController();
      releases.push(bindNativeProviderTransport(base()));
    },
    seed: () => seedConfigured(driver, draft, id),
    async close() {
      for (const dispose of releases.reverse()) dispose();
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
