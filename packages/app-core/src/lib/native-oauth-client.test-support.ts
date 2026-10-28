import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeOAuthClientOwner } from "./native-oauth-client-config.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "./secret-backends/runtime.test-support.js";
import { vaultStore } from "./vault/store.js";

export const CLIENT_ID = "operator: café+client";
export const CLIENT_SECRET = "vault:密碼 + client secret";
export type ClientMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post";
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-oauth-client-"));
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
  const tls = {
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
  return { directory, tls };
}
type FixtureState = {
  challenge: string;
  redirectUri: string;
  resource: string;
  hold: boolean;
  wrongClient: boolean;
  invalidDetails: boolean;
  noExpiry: boolean;
  scope: string;
  issued: number;
  errorMode:
    | "standard"
    | "unknown"
    | "token-bearing"
    | "network"
    | "unexpected-field";
  resourceDenied: boolean;
  holdResource: boolean;
};
type FixtureRequests = {
  path: string;
  method?: string;
  authorization: string;
  body: string;
}[];
type Gate = ReturnType<typeof deferred<void>>;
function validCode(form: URLSearchParams, state: FixtureState): boolean {
  return (
    form.get("grant_type") === "authorization_code" &&
    form.get("code") === "one-use-code" &&
    form.get("redirect_uri") === state.redirectUri &&
    form.get("resource") === state.resource &&
    createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url") === state.challenge
  );
}
async function resourceReply(
  request: IncomingMessage,
  response: ServerResponse,
  state: FixtureState,
  requests: FixtureRequests,
  entered: Gate,
  release: Gate,
) {
  requests.push({
    path: request.url ?? "",
    method: request.method,
    authorization: request.headers.authorization ?? "",
    body: "",
  });
  if (state.holdResource) {
    entered.resolve();
    await release.promise;
  }
  response.setHeader("content-type", "application/json");
  if (
    state.resourceDenied ||
    request.headers.authorization !== `Bearer issued-access-${state.issued}`
  ) {
    response.writeHead(401);
    response.end(JSON.stringify({ error: "denied" }));
    return;
  }
  response.end(
    JSON.stringify({
      projects: [{ id: "project-42", name: "Actual configured project" }],
    }),
  );
}
function rejectedReply(response: ServerResponse, state: FixtureState): void {
  if (state.errorMode === "network") {
    response.destroy();
    return;
  }
  response.writeHead(400);
  if (state.errorMode === "token-bearing") {
    state.issued++;
    response.end(
      JSON.stringify({
        error: "invalid_client",
        access_token: `issued-access-${state.issued}`,
      }),
    );
    return;
  }
  if (state.errorMode === "unexpected-field") {
    response.end(
      JSON.stringify({ error: "invalid_client", unexpected: "unrecognized" }),
    );
    return;
  }
  response.end(
    JSON.stringify({
      error:
        state.errorMode === "unknown" ? "unrecognized_error" : "invalid_client",
      error_description: CLIENT_SECRET,
    }),
  );
}
function tokenServer(
  tls: ReturnType<typeof certificate>["tls"],
  method: ClientMethod,
  state: FixtureState,
  requests: FixtureRequests,
  entered: Gate,
  release: Gate,
) {
  function validClient(form: URLSearchParams, authorization: string): boolean {
    if (state.wrongClient) return false;
    if (method === "none")
      return (
        form.get("client_id") === CLIENT_ID &&
        !form.has("client_secret") &&
        !authorization
      );
    if (method === "client_secret_post")
      return (
        form.get("client_id") === CLIENT_ID &&
        form.get("client_secret") === CLIENT_SECRET &&
        !authorization
      );
    const encode = (value: string) =>
      encodeURIComponent(value)
        .replace(/%20/g, "+")
        .replace(
          /[!'()~]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        );
    const expected = Buffer.from(
      `${encode(CLIENT_ID)}:${encode(CLIENT_SECRET)}`,
    ).toString("base64");
    return (
      authorization === `Basic ${expected}` &&
      !form.has("client_secret") &&
      !form.has("client_id")
    );
  }
  const server = createServer(tls, async (request, response) => {
    if (request.method === "GET" && request.url === "/resource") {
      await resourceReply(request, response, state, requests, entered, release);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const authorization = request.headers.authorization ?? "";
    requests.push({
      path: request.url ?? "",
      method: request.method,
      authorization,
      body,
    });
    const form = new URLSearchParams(body);
    const valid =
      request.method === "POST" &&
      request.url === "/token" &&
      validClient(form, authorization) &&
      validCode(form, state);
    if (state.hold) {
      entered.resolve();
      await release.promise;
    }
    response.setHeader("content-type", "application/json");
    if (!valid) {
      rejectedReply(response, state);
      return;
    }
    state.issued++;
    response.end(
      JSON.stringify({
        access_token: `issued-access-${state.issued}`,
        refresh_token: `issued-refresh-${state.issued}`,
        token_type: state.invalidDetails ? "MAC" : "Bearer",
        expires_in: state.noExpiry ? undefined : 3600,
        scope: state.scope,
      }),
    );
  });
  return server;
}
export async function nativeOAuthClientFixture(method: ClientMethod = "none") {
  const local = await runtimeFixture();
  const { directory, tls } = certificate();
  const requests: { path: string; authorization: string; body: string }[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  const state: FixtureState = {
    challenge: "",
    redirectUri: "https://operator.example/auth/native-connector.html",
    resource: "",
    hold: false,
    wrongClient: false,
    invalidDetails: false,
    noExpiry: false,
    scope: "read:items",
    issued: 0,
    errorMode: "standard",
    resourceDenied: false,
    holdResource: false,
  };
  const server = tokenServer(tls, method, state, requests, entered, release);
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  state.resource = `${origin}/resource`;
  const controller = new AbortController();
  const realFetch = tlsFetch(tls.cert);
  const transport: NativeProviderTransport = {
    fetch: realFetch,
    settleCredentialMutation: realFetch,
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  const owner: NativeOAuthClientOwner = {
    transport,
    tomb: vaultStore.getSnapshot().tomb,
    redirectUri: state.redirectUri,
  };
  const input: NativeDriverInput = {
    providerId: "byo-oauth",
    displayName: "Operator native OAuth",
    method: "oauth",
    parameters: {
      client_id: CLIENT_ID,
      issuer: `${origin}/issuer`,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      token_auth_method: method,
      resource: state.resource,
    },
    credentials: method === "none" ? {} : { client_secret: CLIENT_SECRET },
    requestedScopes: { user: ["read:items"] },
    targetIds: {},
  };
  return {
    input,
    owner,
    state,
    requests,
    controller,
    entered,
    release,
    local,
    async close() {
      release.resolve();
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
      await local.close();
    },
  };
}
