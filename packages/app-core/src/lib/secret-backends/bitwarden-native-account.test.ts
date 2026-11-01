import { createCipheriv, createHmac, pbkdf2Sync } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type BitwardenNativeAccount,
  openBitwardenNativeAccount,
} from "./bitwarden-native-account.js";
import {
  type BitwardenNativeCredentials,
  type BitwardenPasswordUnlock,
  decodeBitwardenPrelogin,
  decodeBitwardenSync,
  decodeBitwardenToken,
} from "./bitwarden-native-protocol.js";
import type { SecretBackendTransport } from "./transport.js";
const USER = "884e35b0-7830-4fce-89ab-4a3b06fae019";
const PASSWORD = " owned 🔐 master password ";
const EMAIL = "person@example.test";
const LIMITS = {
  maxPbkdf2Iterations: 5000,
  maxArgon2Iterations: 2,
  maxArgon2MemoryMiB: 16,
  maxArgon2Parallelism: 1,
};
const LEGACY = { kdf: 0, kdfIterations: 5000, salt: null };
const PARAMETERS = { kdfType: 0, iterations: 5000 };
const MATERIAL = Buffer.from(Array.from({ length: 64 }, (_, i) => i + 1));
function envelope(raw: Uint8Array = MATERIAL, salt = EMAIL): string {
  const master = pbkdf2Sync(PASSWORD, salt, 5000, 32, "sha256");
  const enc = createHmac("sha256", master)
    .update(Buffer.from("enc\x01"))
    .digest();
  const mac = createHmac("sha256", master)
    .update(Buffer.from("mac\x01"))
    .digest();
  const iv = Buffer.alloc(16, 19);
  const cipher = createCipheriv("aes-256-cbc", enc, iv);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = createHmac("sha256", mac).update(iv).update(ciphertext).digest();
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${tag.toString("base64")}`;
}
function modernKey(): Buffer {
  // Independently written COSE map: kty4, kid16, alg-70010, ops[3,4,5,6], key32; then min65 padding.
  const data = Buffer.concat([
    Buffer.from("a501040250", "hex"),
    Buffer.alloc(16, 7),
    Buffer.from("033a00011179048403040506205820", "hex"),
    MATERIAL.subarray(0, 32),
  ]);
  const padding = Math.max(1, 65 - data.length);
  return Buffer.concat([data, Buffer.alloc(padding, padding)]);
}
type Fixture = {
  config: BitwardenNativeCredentials;
  server: Server;
  requests: { path: string; body: string; authorization: string | undefined }[];
  state: {
    prelogin: BoundaryValue;
    status: number;
    token: BoundaryValue;
    sync: BoundaryValue;
    delayToken: boolean;
  };
  controller: AbortController;
  transport: SecretBackendTransport;
};
let fixture: Fixture;
const accounts: BitwardenNativeAccount[] = [];
beforeEach(async () => {
  const state = {
    prelogin: { kdfSettings: PARAMETERS, salt: EMAIL },
    status: 200,
    token: {
      access_token: "owned.synthetic-token",
      token_type: "Bearer",
      expires_in: 60,
      kdf: 0,
      kdfIterations: 5000,
      key: envelope(),
    },
    sync: { profile: { id: USER, email: EMAIL, key: envelope() }, ciphers: [] },
    delayToken: false,
  };
  const requests: Fixture["requests"] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part.toString();
    const path = request.url ?? "";
    requests.push({ path, body, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (path === "/tenant/identity/accounts/prelogin/password") {
      response.writeHead(state.status).end(JSON.stringify(state.prelogin));
      return;
    }
    if (path === "/tenant/identity/accounts/prelogin") {
      response.end(JSON.stringify(LEGACY));
      return;
    }
    if (path === "/tenant/identity/connect/token") {
      if (state.delayToken)
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const form = new URLSearchParams(body);
      if (
        form.get("client_id") !== `user.${USER}` ||
        form.get("client_secret") !== "owned-client-secret" ||
        form.get("scope") !== "api" ||
        form.get("grant_type") !== "client_credentials" ||
        form.get("deviceType") !== "14" ||
        form.get("deviceName") !== "OpenSesame PWA"
      ) {
        response.writeHead(401).end("{}");
        return;
      }
      response.end(JSON.stringify(state.token));
      return;
    }
    if (
      path === "/tenant/api/sync?excludeDomains=true" &&
      request.headers.authorization === "Bearer owned.synthetic-token"
    ) {
      response.end(JSON.stringify(state.sync));
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const bound = z.object({ port: z.number().int().positive() }).parse(address);
  const base = `http://127.0.0.1:${bound.port}/tenant/`;
  const controller = new AbortController();
  fixture = {
    server,
    state,
    requests,
    controller,
    config: {
      baseUrl: `${base}api`,
      identityUrl: `${base}identity`,
      email: " Person@Example.Test ",
      clientId: `user.${USER}`,
      clientSecret: "owned-client-secret",
      deviceIdentifier: "188eadf4-99b2-4dfe-8a0a-e223be316dc7",
    },
    transport: {
      fetch: globalThis.fetch,
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
    },
  };
});
afterEach(async () => {
  for (const account of accounts.splice(0)) account.dispose();
  fixture.controller.abort();
  vi.restoreAllMocks();
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    fixture.server.close((error) => (error ? reject(error) : resolve())),
  );
});
async function connect(password = PASSWORD): Promise<BitwardenNativeAccount> {
  const account = await openBitwardenNativeAccount(
    fixture.config,
    password,
    LIMITS,
    fixture.transport,
  );
  accounts.push(account);
  return account;
}
it("authenticates over actual HTTP, binds sync identity, unlocks independently encrypted account key", async () => {
  const account = await connect();
  expect(Buffer.from(account.key.material)).toEqual(MATERIAL);
  expect(await account.sync()).toEqual([]);
  expect(fixture.requests.map((request) => request.path)).toEqual([
    "/tenant/identity/accounts/prelogin/password",
    "/tenant/identity/connect/token",
    "/tenant/api/sync?excludeDomains=true",
    "/tenant/api/sync?excludeDomains=true",
  ]);
  expect(JSON.parse(fixture.requests[0].body)).toEqual({ email: EMAIL });
  expect(
    fixture.requests.every((request) => !request.body.includes(PASSWORD)),
  ).toBe(true);
  expect(fixture.requests[1].authorization).toBeUndefined();
});
it.each([404, 405])(
  "falls back to legacy prelogin only for actual HTTP %i",
  async (status) => {
    fixture.state.status = status;
    expect((await connect()).key.material.length).toBe(64);
    expect(fixture.requests[1].path).toBe("/tenant/identity/accounts/prelogin");
  },
);
it.each([401, 403, 429, 500])(
  "does not downgrade HTTP %i to legacy prelogin",
  async (status) => {
    fixture.state.status = status;
    await expect(connect()).rejects.toMatchObject({ status });
    expect(fixture.requests.length).toBe(1);
  },
);
it("honors authenticated modern salt/KDF and wrapped aliases without unauthenticated salt normalization", async () => {
  const salt = " Case-Sensitive Salt 🔐 ";
  const wrapped = envelope(modernKey(), salt);
  const unlock = {
    salt,
    kdf: PARAMETERS,
    masterKeyEncryptedUserKey: wrapped,
    masterKeyWrappedUserKey: wrapped,
  };
  fixture.state.sync = {
    Profile: { Id: USER, Email: EMAIL },
    Ciphers: [],
    UserDecryption: { MasterPasswordUnlock: unlock },
  };
  fixture.state.token = {
    access_token: "owned.synthetic-token",
    token_type: "Bearer",
    expires_in: 60,
    userDecryptionOptions: {
      hasMasterPassword: true,
      masterPasswordUnlock: unlock,
    },
  };
  const account = await connect();
  expect(account.key.algorithm).toBe(-70010);
  expect(Buffer.from(account.key.material)).toEqual(MATERIAL.subarray(0, 32));
});
it("rejects real token HTTP 401 without claiming an authenticated session", async () => {
  fixture.config.clientSecret = "deliberately-wrong-owned-secret";
  await expect(connect()).rejects.toMatchObject({ status: 401 });
  expect(fixture.requests).toHaveLength(2);
});
it("fails wrong master password after authentication rather than admitting a token-only session", async () => {
  await expect(connect("wrong password")).rejects.toMatchObject({
    code: "authentication",
  });
  expect(fixture.requests.length).toBe(3);
});
it("rejects missing password and invalid personal credentials before any request", async () => {
  await expect(connect("")).rejects.toMatchObject({ code: "configuration" });
  fixture.config.clientId = "organization.unrelated";
  await expect(connect()).rejects.toMatchObject({ code: "configuration" });
  expect(fixture.requests).toEqual([]);
});
it.each(["id", "email"])(
  "binds authenticated profile %s instead of trusting bearer JWT text",
  async (field) => {
    fixture.state.sync = {
      profile: { id: USER, email: EMAIL, [field]: "other" },
      ciphers: [],
    };
    await expect(connect()).rejects.toMatchObject({ code: "authentication" });
  },
);
it("clears worker-owned key bytes immediately on captured transport revocation", async () => {
  const account = await connect();
  const material = account.key.material;
  fixture.controller.abort();
  expect(account.signal.aborted).toBe(true);
  expect(material.every((byte) => byte === 0)).toBe(true);
  const count = fixture.requests.length;
  await expect(account.sync()).rejects.toBeDefined();
  expect(fixture.requests.length).toBe(count);
});
it("renews personal credentials once for concurrent expired reads", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  const account = await connect();
  clock.mockReturnValue(200000);
  fixture.state.delayToken = true;
  expect(await Promise.all([account.sync(), account.sync()])).toEqual([[], []]);
  expect(
    fixture.requests.filter((request) =>
      request.path.endsWith("connect/token"),
    ),
  ).toHaveLength(2);
});
it("disposes on authenticated unlock metadata change instead of continuing with obsolete keys", async () => {
  const account = await connect();
  const material = account.key.material;
  fixture.state.sync = {
    profile: { id: USER, email: EMAIL, key: envelope(Buffer.alloc(64, 5)) },
    ciphers: [],
  };
  await expect(account.sync()).rejects.toMatchObject({ code: "response" });
  expect(account.signal.aborted).toBe(true);
  expect(material.every((byte) => byte === 0)).toBe(true);
});
it("rejects successful token payloads with invalid type, lifetime or header bytes", () => {
  for (const data of [
    { access_token: "x\r\nx", token_type: "Bearer", expires_in: 60 },
    { access_token: "x", token_type: "Basic", expires_in: 60 },
    { access_token: "x", token_type: "Bearer", expires_in: 0 },
    { access_token: "x", token_type: "Bearer", expires_in: 86401 },
    {
      access_token: "x",
      token_type: "Bearer",
      expires_in: 60,
      scope: "api.organization",
    },
  ])
    expect(() => decodeBitwardenToken(data)).toThrow();
});
it("rejects malformed modern metadata rather than selecting valid legacy fields", () => {
  expect(() =>
    decodeBitwardenPrelogin({ ...LEGACY, kdfSettings: null }, EMAIL),
  ).toThrow();
  const token = { key: envelope(), kdf: 0, kdfIterations: 5000 };
  const prelogin: Omit<BitwardenPasswordUnlock, "wrappedKey"> = {
    salt: EMAIL,
    kdf: { kdfType: 0, iterations: 5000 },
  };
  expect(() =>
    decodeBitwardenSync(
      {
        profile: { id: USER, email: EMAIL },
        ciphers: [],
        userDecryption: { masterPasswordUnlock: null },
      },
      token,
      fixture.config,
      prelogin,
    ),
  ).toThrow();
});
it("rejects contradictory case and encrypted/wrapped aliases", () => {
  expect(() =>
    decodeBitwardenPrelogin({ kdf: 0, Kdf: 1, kdfIterations: 5000 }, EMAIL),
  ).toThrow();
  const data = {
    profile: { id: USER, email: EMAIL },
    ciphers: [],
    userDecryption: {
      masterPasswordUnlock: {
        salt: EMAIL,
        kdf: PARAMETERS,
        masterKeyEncryptedUserKey: "a",
        masterKeyWrappedUserKey: "b",
      },
    },
  };
  expect(() =>
    decodeBitwardenSync(data, {}, fixture.config, {
      salt: EMAIL,
      kdf: { kdfType: 0, iterations: 5000 },
    }),
  ).toThrow();
});
it("cancels a physically incomplete response on revocation and rejects late bytes", async () => {
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const transport: SecretBackendTransport = {
    ...fixture.transport,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"salt":'));
            started();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  };
  const opening = openBitwardenNativeAccount(
    fixture.config,
    PASSWORD,
    LIMITS,
    transport,
  );
  await pending;
  fixture.controller.abort();
  await expect(opening).rejects.toBeDefined();
  expect(cancelled).toBe(true);
});
it("enforces physical auth body size and fatal UTF8 rather than content-length trust", async () => {
  for (const bytes of [
    new Uint8Array(65537).fill(32),
    new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]),
  ]) {
    const transport: SecretBackendTransport = {
      ...fixture.transport,
      fetch: async () =>
        new Response(bytes, {
          headers: { "content-type": "application/json" },
        }),
    };
    await expect(
      openBitwardenNativeAccount(fixture.config, PASSWORD, LIMITS, transport),
    ).rejects.toMatchObject({ code: "response" });
  }
});
