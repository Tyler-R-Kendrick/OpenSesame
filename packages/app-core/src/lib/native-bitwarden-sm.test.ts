import { randomBytes } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  accessTokenKey,
  bytesBase64,
  encryptBytes,
  symmetricKey,
} from "./native-bitwarden-crypto.js";
import { bitwardenSecretsKeyFlows } from "./native-bitwarden-sm.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";

installNativeApiTests();

const ORG = "7a1d3c52-0b6e-4d6f-9f10-2f3c4d5e6f70";
const ACCOUNT = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
const SECRET_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SERVICE_SECRET = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4e";
const enc = new TextEncoder();

const keyBytes = randomBytes(16);
const orgKeyBytes = randomBytes(64);
const orgKey = symmetricKey(orgKeyBytes);
const ACCESS = `0.${ACCOUNT}.${SERVICE_SECRET}:${keyBytes.toString("base64")}`;

const base64Url = (text: string) => Buffer.from(text).toString("base64url");
const bearer = `${base64Url(JSON.stringify({ alg: "RS256" }))}.${base64Url(
  JSON.stringify({ organization: ORG }),
)}.signature-signature-signature`;

let payload = "";
let sealedName = "";
let sealedValue = "";
beforeAll(async () => {
  const tokenKey = await accessTokenKey(keyBytes);
  payload = await encryptBytes(
    enc.encode(JSON.stringify({ encryptionKey: bytesBase64(orgKeyBytes) })),
    tokenKey,
  );
  sealedName = await encryptBytes(enc.encode("DATABASE_URL"), orgKey);
  sealedValue = await encryptBytes(
    enc.encode("postgres://secret-value"),
    orgKey,
  );
});

const draft = (site = "us", token = ACCESS) => ({
  providerId: "bitwarden-sm",
  displayName: "Bitwarden Secrets Manager",
  parameters: { site },
  credentials: { access_token: token },
});

type Route = {
  match: RegExp;
  body: () => object;
  status?: number;
};
function routes(...replies: Route[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies.find((entry) => entry.match.test(url));
    if (!reply) throw new Error(`Unexpected request to ${url}`);
    return new Response(JSON.stringify(reply.body()), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fetch, calls, transport: { fetch, assertCurrent: vi.fn() } };
}
const login = (): Route => ({
  match: /\/connect\/token$/,
  body: () => ({
    access_token: bearer,
    token_type: "Bearer",
    expires_in: 3600,
    encrypted_payload: payload,
  }),
});
const list = (): Route => ({
  match: new RegExp(`/organizations/${ORG}/secrets$`),
  body: () => ({
    data: [{ id: SECRET_ID, organizationId: ORG, key: sealedName }],
  }),
});
const one = (): Route => ({
  match: new RegExp(`/secrets/${SECRET_ID}$`),
  body: () => ({
    id: SECRET_ID,
    organizationId: ORG,
    key: sealedName,
    value: sealedValue,
    note: "",
  }),
});

it("logs in as the service account at Bitwarden's identity server and opens the payload only its token can open", async () => {
  const fixture = routes(login());
  const saved = await bitwardenSecretsKeyFlows.configure(
    draft(),
    fixture.transport,
  );
  expect(saved).toMatchObject({
    status: "connected",
    identity: { kind: "machine-account" },
  });
  const [call] = fixture.calls;
  expect(call?.url).toBe("https://identity.bitwarden.com/connect/token");
  expect(new URLSearchParams(String(call?.init?.body)).toString()).toBe(
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "api.secrets",
      client_id: ACCOUNT,
      client_secret: SERVICE_SECRET,
    }).toString(),
  );
  expect(new Headers(call?.init?.headers).get("device-type")).toBe("21");
  // The encryption key half of the token never leaves this device.
  expect(String(call?.init?.body)).not.toContain(keyBytes.toString("base64"));
  for (const text of [
    JSON.stringify(saved),
    JSON.stringify(readDeviceRows()),
  ]) {
    expect(text).not.toContain(SERVICE_SECRET);
    expect(text).not.toContain(bearer);
  }
});

it("logs in at the EU region's servers when that is the region chosen", async () => {
  const fixture = routes(login());
  await bitwardenSecretsKeyFlows.configure(draft("eu"), fixture.transport);
  expect(fixture.calls[0]?.url).toBe(
    "https://identity.bitwarden.eu/connect/token",
  );
});

it("refuses a token that is not a service account's, or a payload another token's key made, before saving anything", async () => {
  for (const bad of [
    "not-a-token",
    `0.${ACCOUNT}.short:${keyBytes.toString("base64")}`,
    `1.${ACCOUNT}.${SERVICE_SECRET}:${keyBytes.toString("base64")}`,
    `0.${ACCOUNT}.${SERVICE_SECRET}:`,
  ]) {
    const fixture = routes(login());
    await expect(
      bitwardenSecretsKeyFlows.configure(draft("us", bad), fixture.transport),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
  // A genuine-looking token with a different encryption key cannot open the payload.
  const other = `0.${ACCOUNT}.${SERVICE_SECRET}:${randomBytes(16).toString("base64")}`;
  await expect(
    bitwardenSecretsKeyFlows.configure(
      draft("us", other),
      routes(login()).transport,
    ),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual([]);
});

it.each([
  [401, "refused"],
  [403, "permissions"],
  [429, "rate limit"],
  [500, "expected response"],
])(
  "classifies Bitwarden's %s without repeating what it said, and saves nothing",
  async (status, words) => {
    const message = "invalid_client for machine@private.example";
    const failure = await bitwardenSecretsKeyFlows
      .configure(
        draft(),
        routes({ ...login(), body: () => ({ error: message }), status })
          .transport,
      )
      .then(
        () => null,
        (error) => error,
      );
    if (!(failure instanceof Error)) throw new Error("A refusal must throw");
    expect(failure.message.toLowerCase()).toContain(words);
    expect(failure.message).not.toContain(message);
    expect(readDeviceRows()).toEqual([]);
  },
);

it("lists secret names decrypted here, and reads a value once under the organization key", async () => {
  const saved = await bitwardenSecretsKeyFlows.configure(
    draft(),
    routes(login()).transport,
  );
  const listing = routes(login(), list());
  const names = await bitwardenSecretsKeyFlows.invoke(
    saved.connectionId,
    "provider.names.read",
    {},
    listing.transport,
  );
  expect(names.items).toEqual([{ id: SECRET_ID, label: "DATABASE_URL" }]);
  expect(listing.calls[1]?.url).toBe(
    `https://api.bitwarden.com/organizations/${ORG}/secrets`,
  );
  expect(
    new Headers(listing.calls[1]?.init?.headers).get("authorization"),
  ).toBe(`Bearer ${bearer}`);
  // What Bitwarden sent is ciphertext; the name above exists only after decryption here.
  expect(JSON.stringify(listing.calls)).not.toContain("DATABASE_URL");

  const reading = routes(login(), one());
  const value = await bitwardenSecretsKeyFlows.invoke(
    saved.connectionId,
    "provider.secret.read",
    { secret: SECRET_ID },
    reading.transport,
  );
  expect(value.items[0]).toMatchObject({
    id: SECRET_ID,
    label: "DATABASE_URL",
    secretValue: "postgres://secret-value",
  });
  for (const text of [
    JSON.stringify(loadNativeConnectorRecord(saved.connectionId)),
  ])
    expect(text).not.toContain("postgres://secret-value");
});

it("refuses a secret ID that is not one before any request, and a secret answer that is another's or not decryptable", async () => {
  const saved = await bitwardenSecretsKeyFlows.configure(
    draft(),
    routes(login()).transport,
  );
  for (const secret of ["", "../x", "not-a-uuid"]) {
    const fixture = routes(login(), one());
    await expect(
      bitwardenSecretsKeyFlows.invoke(
        saved.connectionId,
        "provider.secret.read",
        { secret },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
  const foreign = {
    ...one(),
    body: () => ({
      id: SECRET_ID,
      organizationId: "11111111-1111-4111-8111-111111111111",
      key: sealedName,
      value: sealedValue,
    }),
  };
  await expect(
    bitwardenSecretsKeyFlows.invoke(
      saved.connectionId,
      "provider.secret.read",
      { secret: SECRET_ID },
      routes(login(), foreign).transport,
    ),
  ).rejects.toThrow();
  const garbage = {
    ...one(),
    body: () => ({
      id: SECRET_ID,
      organizationId: ORG,
      key: sealedName,
      value: "2.AAAA|BBBB|CCCC",
    }),
  };
  await expect(
    bitwardenSecretsKeyFlows.invoke(
      saved.connectionId,
      "provider.secret.read",
      { secret: SECRET_ID },
      routes(login(), garbage).transport,
    ),
  ).rejects.toThrow();
});
