import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { overlapCast } from "@opensesame/os-domain";
import type { Provider } from "oidc-provider";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createOpenSesameProvider } from "../create-provider.js";

const LIMIT = 64 * 1024;
const REDIRECT = "https://rp.example/cb";
const SECTOR = "https://rp.example/sector.json";
const JWKS = "https://rp.example/jwks.json";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwks = JSON.stringify({
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "rp", alg: "RS256" }],
});
const originalFetch = globalThis.fetch;
let server: Server;
let issuer: string;
let handler: ReturnType<Provider["callback"]>;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo = overlapCast(server.address());
  issuer = `http://127.0.0.1:${address.port}`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function provider(dcrEnabled = true) {
  const client = {
    client_id: "rp",
    token_endpoint_auth_method: "private_key_jwt",
    jwks_uri: JWKS,
    redirect_uris: [REDIRECT],
  };
  const bundle = createOpenSesameProvider({
    issuer,
    env: { dcrEnabled },
    clients: [client],
  });
  handler = bundle.provider.callback();
  return bundle;
}

/** Replace only the remote HTTP response; native validation and body reading still run. */
function remoteResponse(url: string, response: Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input) === url) return Promise.resolve(response);
    return originalFetch(input, init);
  });
}

async function register() {
  return fetch(`${issuer}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      sector_identifier_uri: SECTOR,
    }),
  });
}

async function authenticate() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "rp" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "rp",
      sub: "rp",
      aud: issuer,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(data)
    .sign(privateKey, "base64url");
  return fetch(`${issuer}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "nonexistent",
      redirect_uri: REDIRECT,
      client_id: "rp",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: `${data}.${signature}`,
    }),
  });
}

const purposes = [
  {
    name: "sector_identifier_uri",
    url: SECTOR,
    body: JSON.stringify([REDIRECT]),
    request: register,
    okStatus: 201,
    error: "invalid_client_metadata",
  },
  {
    name: "jwks_uri",
    url: JWKS,
    body: jwks,
    request: authenticate,
    okStatus: 400,
    error: "invalid_client",
  },
];

describe.each(purposes)(
  "native $name response limit",
  ({ url, body, request, okStatus, error }) => {
    it.each([body.length, LIMIT])(
      "accepts legitimate JSON of %i bytes",
      async (size) => {
        provider();
        const spy = remoteResponse(url, new Response(body.padEnd(size, " ")));
        const res = await request();
        expect(res.status).toBe(okStatus);
        if (url === JWKS)
          expect(await res.json()).toMatchObject({ error: "invalid_grant" });
        expect(spy.mock.calls.some(([input]) => String(input) === url)).toBe(
          true,
        );
      },
    );

    it.each(["fixed", "chunked"])(
      "rejects oversized %s JSON bodies",
      async (framing) => {
        provider();
        const response = new Response(body.padEnd(LIMIT + 1, " "), {
          headers:
            framing === "fixed" ? { "content-length": String(LIMIT + 1) } : {},
        });
        remoteResponse(url, response);
        const res = await request();
        expect(res.status).toBe(url === JWKS ? 401 : 400);
        expect(await res.json()).toMatchObject({ error });
        // An ordinary request still works after the oversized remote body is rejected.
        const discovery = await fetch(
          `${issuer}/.well-known/openid-configuration`,
        );
        expect(discovery.status).toBe(200);
      },
    );

    it("cancels a declared oversized body before reading it", async () => {
      provider();
      const pull = vi.fn();
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
        {
          headers: { "content-length": String(LIMIT + 1) },
        },
      );
      remoteResponse(url, response);
      const res = await request();
      expect(await res.json()).toMatchObject({ error });
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("cancels an unbounded stream once the byte budget is crossed", async () => {
      provider();
      const cancel = vi.fn();
      let reads = 0;
      const response = new Response(
        new ReadableStream(
          {
            pull(controller) {
              reads += 1;
              controller.enqueue(new Uint8Array(16 * 1024));
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      );
      remoteResponse(url, response);
      const res = await request();
      expect(await res.json()).toMatchObject({ error });
      expect(reads).toBe(5);
      expect(cancel).toHaveBeenCalledOnce();
    });
  },
);

it("keeps dynamic registration disabled when the flag is off", async () => {
  const bundle = provider(false);
  expect(bundle.configuration.features).toMatchObject({
    registration: { enabled: false },
  });
  const res = await register();
  expect(res.status).toBe(404);
});
