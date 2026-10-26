/** Independent Node TLS IdP: verify real code/client authentication and sign outside JOSE. */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { z } from "zod";
import { tlsFetch } from "../../lib/native-s3-backup.test-support.js";
import { consumeNativeOidcProof } from "./claims.js";
import { prepareConfiguredOidc } from "./transaction.js";

const callback =
  "https://pwa.example.test/OpenSesame/auth/native-connector.html";
const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...signing.publicKey.export({ format: "jwk" }),
  kid: "independent-tls",
  alg: "RS256",
};
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "oidc-protocol-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  try {
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
        "subjectAltName=IP:127.0.0.1,IP:127.0.0.2",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign,cRLSign",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    return {
      directory,
      tls: { key: readFileSync(key), cert: readFileSync(cert) },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
function configuration(method: string) {
  return {
    issuer: "",
    clientId: "client: café",
    clientSecret: method === "none" ? "" : "operator: secret",
    scope: "openid profile",
    organization: {
      id: "org_actual",
      authorizationParameter: "organization",
      claim: "org_id",
    },
  };
}
type Exchange = { path: string; body: string; basic: string; host: string };
type OracleState = {
  config: ReturnType<typeof configuration>;
  tokenBase: string;
  jwksBase: string;
  authorization: URL | null;
  onRequest: ((path: string) => void) | null;
  beforeResponse: ((path: string) => Promise<void>) | null;
  closed: string[];
  requests: Exchange[];
  errors: unknown[];
};
function token(
  request: IncomingMessage,
  body: string,
  state: OracleState,
  method: string,
) {
  expect(request.method).toBe("POST");
  expect(request.headers["content-type"]).toBe(
    "application/x-www-form-urlencoded",
  );
  const form = new URLSearchParams(body);
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("code")).toBe("independent-once");
  expect(form.get("redirect_uri")).toBe(callback);
  expect(form.get("client_id")).toBe(state.config.clientId);
  expect(
    state.requests.filter((row) => row.path.endsWith("/token")),
  ).toHaveLength(1);
  const authorization = state.authorization;
  if (!authorization) throw new Error("No original authorization");
  expect(
    createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url"),
  ).toBe(authorization.searchParams.get("code_challenge"));
  const basic = request.headers.authorization ?? "";
  if (method === "client_secret_basic") {
    expect(Buffer.from(basic.slice(6), "base64").toString()).toBe(
      "client%3A+caf%C3%A9:operator%3A+secret",
    );
    expect(form.has("client_secret")).toBe(false);
  } else {
    expect(basic).toBe("");
    expect(form.get("client_secret")).toBe(
      method === "none" ? null : state.config.clientSecret,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    { alg: "RS256", kid: jwk.kid, typ: "JWT" },
    {
      iss: state.config.issuer,
      aud: state.config.clientId,
      sub: "owned-person",
      iat: now,
      exp: now + 120,
      nonce: authorization.searchParams.get("nonce"),
      org_id: "org_actual",
    },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return {
    id_token: `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), signing.privateKey).toString("base64url")}`,
  };
}
async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  state: OracleState,
  method: string,
) {
  request.socket.once("close", () => state.closed.push(request.url ?? ""));
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    state.requests.push({
      path: request.url ?? "",
      body,
      basic: request.headers.authorization ?? "",
      host: request.headers.host ?? "",
    });
    state.onRequest?.(request.url ?? "");
    await state.beforeResponse?.(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/issuer/.well-known/openid-configuration") {
      expect(request.method).toBe("GET");
      response.end(
        JSON.stringify({
          issuer: state.config.issuer,
          authorization_endpoint: `${state.tokenBase}/authorize`,
          token_endpoint: `${state.tokenBase}/token`,
          jwks_uri: `${state.jwksBase}/jwks`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [method],
        }),
      );
    } else if (request.url === "/issuer/jwks") {
      expect(request.method).toBe("GET");
      response.end(JSON.stringify({ keys: [jwk] }));
    } else if (request.url === "/issuer/token") {
      response.end(JSON.stringify(token(request, body, state, method)));
    } else throw new Error("Unexpected OIDC request");
  } catch (error) {
    state.errors.push(error);
    response.writeHead(500).end();
  }
}
type OwnedTlsServers = ReturnType<typeof createServer>[];
export async function tlsOracle(
  method: string,
  split: "token" | "jwks" | "both" | "none" = "none",
) {
  const { directory, tls } = certificate();
  const owned: OwnedTlsServers = [];
  disposers.push(async () => {
    for (const server of owned) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const config = configuration(method);
  const state: OracleState = {
    config,
    tokenBase: "",
    jwksBase: "",
    authorization: null,
    onRequest: null,
    beforeResponse: null,
    closed: [],
    requests: [],
    errors: [],
  };
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void receive(request, response, state, method);
  };
  const server = createServer(tls, listener);
  owned.push(server);
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  config.issuer = `https://127.0.0.1:${port}/issuer`;
  state.tokenBase = config.issuer;
  state.jwksBase = config.issuer;
  if (split !== "none") {
    const delegated = createServer(tls, listener);
    owned.push(delegated);
    await once(delegated.listen(0, "127.0.0.2"), "listening");
    const address = z.object({ port: z.number() }).parse(delegated.address());
    const base = `https://127.0.0.2:${address.port}/issuer`;
    if (split !== "jwks") state.tokenBase = base;
    if (split !== "token") state.jwksBase = base;
  }
  const approved = new Set([
    new URL(config.issuer).origin,
    new URL(state.tokenBase).origin,
    new URL(state.jwksBase).origin,
  ]);
  const lifetime = new AbortController();
  const owner = {
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  };
  return {
    operatorCA: tls.cert.toString(),
    closed: state.closed,
    beforeResponse: (callback: ((path: string) => Promise<void>) | null) => {
      state.beforeResponse = callback;
    },
    config,
    errors: state.errors,
    requests: state.requests,
    tokenBase: state.tokenBase,
    jwksBase: state.jwksBase,
    withdraw: (origin: string) => approved.delete(origin),
    approve: (origin: string) => approved.add(origin),
    observe: (onRequest: (path: string) => void) => {
      state.onRequest = onRequest;
    },
    owner,
    transport: {
      ...owner,
      fetch: tlsFetch(tls.cert),
      supportsNativeOrigin: (origin: string) => approved.has(origin),
    },
    authorize: (url: string) => {
      state.authorization = new URL(url);
    },
  };
}

/** Mutations happen while the genuine original TLS response is still pending. */
export async function assertOriginalOidcAuthority(
  field: string,
  phase: string,
) {
  const idp = await tlsOracle("client_secret_basic", "both");
  const mutate = () => {
    switch (field) {
      case "transport fetch": {
        const original = idp.transport.fetch;
        idp.transport.fetch = (input, init) => original(input, init);
        break;
      }
      case "transport assertion":
        idp.transport.assertCurrent = () => {};
        break;
      case "transport signal":
        idp.transport.signal = new AbortController().signal;
        break;
      case "owner assertion":
        idp.owner.assertCurrent = () => {};
        break;
      case "owner signal":
        idp.owner.signal = new AbortController().signal;
        break;
      default:
        throw new Error("Unknown mutation field");
    }
  };
  if (phase === "support reentry") {
    const original = idp.transport.supportsNativeOrigin;
    let first = true;
    idp.transport.supportsNativeOrigin = (origin) => {
      if (first) {
        first = false;
        mutate();
      }
      return original(origin);
    };
  } else {
    idp.observe((path) => {
      const expected =
        phase === "discovery"
          ? "/issuer/.well-known/openid-configuration"
          : phase === "token"
            ? "/issuer/token"
            : "/issuer/jwks";
      if (phase !== "proof consumption" && path === expected) mutate();
    });
  }
  const perform = async () => {
    const attempt = await prepareConfiguredOidc(
      idp.config,
      callback,
      idp.transport,
      idp.owner,
    );
    idp.authorize(attempt.authorizationUrl);
    const proof = await attempt.complete({
      state: attempt.state,
      code: "independent-once",
      error: false,
    });
    if (phase === "proof consumption") mutate();
    consumeNativeOidcProof(proof);
  };
  await expect(perform()).rejects.toThrow(/original|changed/i);
  expect(idp.requests).toHaveLength(
    phase === "support reentry"
      ? 0
      : phase === "discovery"
        ? 1
        : phase === "token"
          ? 2
          : 3,
  );
  expect(idp.errors).toEqual([]);
}

export async function assertOidcConfigurationSnapshot() {
  const idp = await tlsOracle("client_secret_basic");
  const input = { ...idp.config, organization: { ...idp.config.organization } };
  const original = idp.owner.assertCurrent;
  idp.owner.assertCurrent = () => {
    original();
    input.clientSecret = "changed after original capture";
    input.organization.id = "changed after original capture";
  };
  const attempt = await prepareConfiguredOidc(
    input,
    callback,
    idp.transport,
    idp.owner,
  );
  idp.authorize(attempt.authorizationUrl);
  const proof = await attempt.complete({
    state: attempt.state,
    code: "independent-once",
    error: false,
  });
  expect(consumeNativeOidcProof(proof).claims.organizationId).toBe(
    "org_actual",
  );
  expect(idp.errors).toEqual([]);
}
