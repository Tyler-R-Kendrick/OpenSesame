import { type KeyObject, createSign, generateKeyPairSync } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { ClientMetadata } from "oidc-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenSesameProvider } from "../create-provider.js";
import {
  SERVICE_ACCESS_TOKEN_MAX_SECONDS,
  assertConfidentialClientCredentials,
  isPublicClient,
} from "../grants/client-credentials.js";
import { ReplayCache } from "../grants/replay-cache.js";

const SECRET = "s3cret";
const API = "https://api.example.test";
const PUBLIC_SPA: ClientMetadata = {
  client_id: "spa",
  token_endpoint_auth_method: "none",
  redirect_uris: ["http://127.0.0.1:4000/cb"],
  grant_types: ["authorization_code"],
  response_types: ["code"],
  subject_type: "pairwise",
};
const CONFIDENTIAL: ClientMetadata = {
  client_id: "svc",
  client_secret: SECRET,
  grant_types: ["client_credentials"],
  response_types: [],
  token_endpoint_auth_method: "client_secret_basic",
  subject_type: "pairwise",
};

let server: Server;
let issuer: string;
let handler: ((req: BoundaryValue, res: BoundaryValue) => void) | undefined;
let jwtPrivate: KeyObject;
let jwtPublic: JsonObject;
let otherPrivate: KeyObject;

function basicAuth(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

function signJwt(
  key: KeyObject,
  header: JsonObject,
  payload: JsonObject,
): string {
  const head = Buffer.from(JSON.stringify(header)).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${head}.${body}`;
  const sig = createSign("RSA-SHA256").update(data).sign(key, "base64url");
  return `${data}.${sig}`;
}

function clientAssertion(key: KeyObject, jti: string, aud: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    key,
    { alg: "RS256", kid: "cc-1", typ: "JWT" },
    {
      iss: "jwt-cc",
      sub: "jwt-cc",
      aud,
      exp: now + 60,
      iat: now,
      jti,
    },
  );
}

type PostTokenHeaders = {
  Authorization?: string;
};

type PostTokenResponse = {
  status: number;
  json: JsonObject;
};

async function postToken(
  body: URLSearchParams,
  headers: PostTokenHeaders = {},
) {
  const res = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
  return { status: res.status, json: overlapCast(await res.json()) };
}

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  jwtPrivate = privateKey;
  jwtPublic = overlapCast(publicKey.export({ format: "jwk" }));
  jwtPublic.kid = "cc-1";
  jwtPublic.use = "sig";
  jwtPublic.alg = "RS256";
  otherPrivate = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

  server = createServer((req, res) => {
    handler?.(overlapCast(req), overlapCast(res));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo = overlapCast(server.address());
  issuer = `http://127.0.0.1:${address.port}`;
  const bundle = createOpenSesameProvider({
    issuer,
    processEnv: {},
    env: { allowedResources: [API] },
    clients: [
      PUBLIC_SPA,
      CONFIDENTIAL,
      {
        client_id: "jwt-cc",
        token_endpoint_auth_method: "private_key_jwt",
        grant_types: ["client_credentials"],
        response_types: [],
        subject_type: "pairwise",
        jwks: { keys: [jwtPublic] },
      },
    ],
  });
  handler = bundle.provider.callback();
  expect(bundle.configuration.features).toMatchObject({
    clientCredentials: { enabled: true },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("ReplayCache", () => {
  it("accepts a jti once and rejects a replay until expiry", () => {
    let now = 1_000;
    const cache = new ReplayCache(() => now);
    expect(cache.remember("iss-a", "jti-1", 2_000)).toBe(true);
    expect(cache.remember("iss-a", "jti-1", 2_000)).toBe(false);
    expect(cache.has("iss-a", "jti-1")).toBe(true);
    expect(cache.remember("iss-b", "jti-1", 2_000)).toBe(true);
    now = 2_001;
    expect(cache.remember("iss-a", "jti-1", 3_000)).toBe(true);
  });
});

describe("client_credentials grant", () => {
  it("treats token_endpoint_auth_method none and missing secret as public", () => {
    expect(isPublicClient({ token_endpoint_auth_method: "none" })).toBe(true);
    expect(
      isPublicClient({ token_endpoint_auth_method: "client_secret_basic" }),
    ).toBe(true);
    expect(
      isPublicClient({
        token_endpoint_auth_method: "client_secret_basic",
        client_secret: SECRET,
      }),
    ).toBe(false);
    expect(
      isPublicClient({ token_endpoint_auth_method: "private_key_jwt" }),
    ).toBe(false);
  });

  it("refuses to register a public client with client_credentials", () => {
    expect(() =>
      assertConfidentialClientCredentials({
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "none",
      }),
    ).toThrow(/public clients cannot use the client_credentials grant/);
  });

  it("denies the grant for origin-style public clients", async () => {
    const { status, json } = await postToken(
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "spa",
      }),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(json.error).toBeTruthy();
    expect(json.access_token).toBeUndefined();
  });

  it("mints an access token for a confidential client, never id/refresh", async () => {
    const { status, json } = await postToken(
      new URLSearchParams({ grant_type: "client_credentials" }),
      { Authorization: basicAuth("svc", SECRET) },
    );
    expect(status).toBe(200);
    expect(json.access_token).toEqual(expect.any(String));
    expect(json.token_type).toBe("Bearer");
    expect(json.id_token).toBeUndefined();
    expect(json.refresh_token).toBeUndefined();
    expect(json.expires_in).toBeLessThanOrEqual(
      SERVICE_ACCESS_TOKEN_MAX_SECONDS,
    );
  });

  it("rejects a resource indicator that is not allowlisted", async () => {
    const { status, json } = await postToken(
      new URLSearchParams({
        grant_type: "client_credentials",
        resource: "https://evil.example.test",
      }),
      { Authorization: basicAuth("svc", SECRET) },
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(json.error).toBe("invalid_target");
  });

  it("rejects a private_key_jwt signed with the wrong key", async () => {
    const assertion = clientAssertion(otherPrivate, "jti-wrong", issuer);
    const { status, json } = await postToken(
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "jwt-cc",
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(json.error).toBe("invalid_client");
    expect(json.access_token).toBeUndefined();
  });

  it("rejects a replayed private_key_jwt jti", async () => {
    const assertion = clientAssertion(jwtPrivate, "jti-replay", issuer);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "jwt-cc",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
    const first = await postToken(body);
    expect(first.status).toBe(200);
    expect(first.json.access_token).toEqual(expect.any(String));
    const replay = await postToken(body);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.json.error).toBe("invalid_client");
  });
});
