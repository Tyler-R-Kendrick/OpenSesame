import { randomBytes } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  encryptBytes,
  masterKey,
  stretchMasterKey,
  symmetricKey,
} from "./native-bitwarden-crypto.js";
import { bitwardenVaultKeyFlows } from "./native-bitwarden-vault.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";

installNativeApiTests();

const EMAIL = "Me@Example.com";
const PASSWORD = "correct horse battery staple";
const CLIENT_ID = "user.3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
const CLIENT_SECRET = "AbCdEf0123456789GhIjKlMn";
const LOGIN_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const KEYED_ID = "33333333-3333-4333-8333-333333333333";
const LOWER_ID = "77777777-7777-4777-8777-777777777777";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const BEARER = "eyJhbGciOiJSUzI1NiJ9.vault-access-token-0123456789.signature";
const enc = new TextEncoder();
const KDF = { kind: "pbkdf2", iterations: 5000 } as const;

const userKeyBytes = randomBytes(64);
const userKey = symmetricKey(userKeyBytes);
const itemKeyBytes = randomBytes(64);
let sealedUserKey = "";
/** The vault the fake server holds: set once the keys exist. */
type Held = { rows: object[] };
const held: Held = { rows: [] };
beforeAll(async () => {
  const master = await masterKey(PASSWORD, EMAIL, KDF);
  sealedUserKey = await encryptBytes(
    userKeyBytes,
    await stretchMasterKey(master),
  );
  const seal = (text: string, key = userKey) =>
    encryptBytes(enc.encode(text), key);
  const itemKey = symmetricKey(itemKeyBytes);
  held.rows = [
    {
      id: LOWER_ID,
      type: 1,
      name: await seal("Lower"),
      login: { password: await seal("lower-secret") },
      organizationId: null,
      deletedDate: null,
    },
    {
      Id: LOGIN_ID,
      Type: 1,
      Name: await seal("GitHub"),
      Login: {
        Username: await seal("me"),
        Password: await seal("p@ss-from-vault"),
      },
      OrganizationId: null,
      DeletedDate: null,
    },
    {
      Id: NOTE_ID,
      Type: 2,
      Name: await seal("Recovery codes"),
      Notes: await seal("alpha bravo charlie"),
      OrganizationId: null,
      DeletedDate: null,
    },
    {
      Id: KEYED_ID,
      Type: 1,
      Key: await encryptBytes(itemKeyBytes, userKey),
      Name: await seal("Keyed item", itemKey),
      Login: { Password: await seal("keyed-secret", itemKey) },
      OrganizationId: null,
      DeletedDate: null,
    },
    {
      Id: ORG_ID,
      Type: 1,
      Name: "2.AAAA|BBBB|CCCC",
      OrganizationId: "55555555-5555-4555-8555-555555555555",
      DeletedDate: null,
    },
    {
      Id: "66666666-6666-4666-8666-666666666666",
      Type: 1,
      Name: "2.AAAA|BBBB|CCCC",
      OrganizationId: null,
      DeletedDate: "2026-01-01T00:00:00Z",
    },
  ];
});

const draft = (
  change: Partial<NativeApiConfigureInput> = {},
): NativeApiConfigureInput => ({
  providerId: "bitwarden",
  displayName: "Bitwarden",
  parameters: { site: "us" },
  credentials: {
    email: EMAIL,
    master_password: PASSWORD,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  },
  ...change,
});

type Route = { match: RegExp; body: () => object; status?: number };
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
const login = (key = () => sealedUserKey): Route => ({
  match: /\/connect\/token$/,
  body: () => ({
    access_token: BEARER,
    token_type: "Bearer",
    expires_in: 3600,
    Key: key(),
    Kdf: 0,
    KdfIterations: 5000,
  }),
});
const sync: Route = {
  match: /\/sync\?excludeDomains=true$/,
  body: () => ({ Ciphers: held.rows }),
};
const cipher = (id: string): Route => ({
  match: new RegExp(`/ciphers/${id}$`),
  body: () =>
    held.rows.find(
      (row) => ("Id" in row && row.Id === id) || ("id" in row && row.id === id),
    ) ?? {},
});

it("logs in with the personal API key and opens the vault key with the master password that never leaves the device", async () => {
  const fixture = routes(login());
  const saved = await bitwardenVaultKeyFlows.configure(
    draft(),
    fixture.transport,
  );
  expect(saved).toMatchObject({
    status: "connected",
    identity: { kind: "vault-account" },
  });
  const [call] = fixture.calls;
  expect(call?.url).toBe("https://identity.bitwarden.com/connect/token");
  const form = new URLSearchParams(String(call?.init?.body));
  expect(form.get("grant_type")).toBe("client_credentials");
  expect(form.get("scope")).toBe("api");
  expect(form.get("client_id")).toBe(CLIENT_ID);
  expect(form.get("deviceIdentifier")).toMatch(/^[0-9a-f-]{36}$/);
  expect(String(call?.init?.body)).not.toContain(PASSWORD);
  expect(String(call?.init?.body)).not.toContain(encodeURIComponent(EMAIL));
  for (const text of [
    JSON.stringify(saved),
    JSON.stringify(readDeviceRows()),
  ]) {
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(BEARER);
  }
});

it("refuses a wrong master password as the account's refusal, without saying why, and saves nothing", async () => {
  const failure = await bitwardenVaultKeyFlows
    .configure(
      draft({
        credentials: {
          email: EMAIL,
          master_password: "wrong password",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        },
      }),
      routes(login()).transport,
    )
    .then(
      () => null,
      (error) => error,
    );
  if (!(failure instanceof Error)) throw new Error("A refusal must throw");
  expect(failure.message.toLowerCase()).toContain("refused");
  expect(readDeviceRows()).toEqual([]);
});

it("refuses a form that asks for anything else, or an API key that is not one, before any request", async () => {
  const base = draft().credentials;
  const bad: Partial<NativeApiConfigureInput>[] = [
    { parameters: { site: "us", server: "https://evil.test" } },
    { parameters: { site: "https://evil.test" } },
    { credentials: { ...base, client_id: "not-user" } },
    { credentials: { ...base, client_secret: "short" } },
    { credentials: { ...base, email: "not an email" } },
    { credentials: { ...base, master_password: "" } },
    { credentials: { ...base, extra: "x" } },
    { requestedScopes: { app: ["x"] } },
  ];
  for (const change of bad) {
    const fixture = routes(login());
    await expect(
      bitwardenVaultKeyFlows.configure(draft(change), fixture.transport),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
});

it("lists personal item names decrypted here, including an item with its own key, and skips organization and deleted items", async () => {
  const saved = await bitwardenVaultKeyFlows.configure(
    draft(),
    routes(login()).transport,
  );
  const listing = routes(login(), sync);
  const result = await bitwardenVaultKeyFlows.invoke(
    saved.connectionId,
    "provider.names.read",
    {},
    listing.transport,
  );
  expect(result.items).toEqual([
    { id: LOWER_ID, label: "Lower · login" },
    { id: LOGIN_ID, label: "GitHub · login" },
    { id: NOTE_ID, label: "Recovery codes · note" },
    { id: KEYED_ID, label: "Keyed item · login" },
  ]);
  expect(
    new Headers(listing.calls[1]?.init?.headers).get("authorization"),
  ).toBe(`Bearer ${BEARER}`);
  expect(JSON.stringify(listing.calls)).not.toContain("GitHub");
});

it("reads a login's password, a note and a keyed item once, and keeps none of them", async () => {
  const saved = await bitwardenVaultKeyFlows.configure(
    draft(),
    routes(login()).transport,
  );
  const read = async (id: string, route: Route) =>
    (
      await bitwardenVaultKeyFlows.invoke(
        saved.connectionId,
        "provider.item.read",
        { item: id },
        routes(login(), route).transport,
      )
    ).items[0];
  expect(await read(LOGIN_ID, cipher(LOGIN_ID))).toMatchObject({
    label: "GitHub",
    secretValue: "p@ss-from-vault",
  });
  expect(await read(NOTE_ID, cipher(NOTE_ID))).toMatchObject({
    label: "Recovery codes",
    secretValue: "alpha bravo charlie",
  });
  expect(await read(KEYED_ID, cipher(KEYED_ID))).toMatchObject({
    secretValue: "keyed-secret",
  });
  expect(
    JSON.stringify(loadNativeConnectorRecord(saved.connectionId)),
  ).not.toContain("p@ss-from-vault");
  for (const item of ["", "../x", "not-a-uuid"]) {
    const fixture = routes(login(), sync);
    await expect(
      bitwardenVaultKeyFlows.invoke(
        saved.connectionId,
        "provider.item.read",
        { item },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
  await expect(
    bitwardenVaultKeyFlows.invoke(
      saved.connectionId,
      "provider.item.read",
      { item: ORG_ID },
      routes(login(), cipher(ORG_ID)).transport,
    ),
  ).rejects.toThrow();
});

it("reaches a Vaultwarden at the address given, over HTTPS only", async () => {
  const hosted = (server: string) =>
    draft({
      providerId: "vaultwarden",
      displayName: "Vaultwarden",
      parameters: { server },
    });
  const fixture = routes(login());
  await bitwardenVaultKeyFlows.configure(
    hosted("https://vault.example.com/"),
    fixture.transport,
  );
  expect(fixture.calls[0]?.url).toBe(
    "https://vault.example.com/identity/connect/token",
  );
  for (const server of [
    "http://vault.example.com",
    "https://u:p@vault.example.com",
    "https://vault.example.com/?x=1",
    "not a url",
    "",
  ]) {
    const refused = routes(login());
    await expect(
      bitwardenVaultKeyFlows.configure(hosted(server), refused.transport),
    ).rejects.toThrow();
    expect(refused.fetch).not.toHaveBeenCalled();
  }
  await expect(
    bitwardenVaultKeyFlows.configure(
      draft({ providerId: "vaultwarden", parameters: { site: "us" } }),
      routes(login()).transport,
    ),
  ).rejects.toThrow();
});

it("reads a login's password from a Vaultwarden answer that spells nested fields in lower case", async () => {
  const saved = await bitwardenVaultKeyFlows.configure(
    draft(),
    routes(login()).transport,
  );
  const result = await bitwardenVaultKeyFlows.invoke(
    saved.connectionId,
    "provider.item.read",
    { item: LOWER_ID },
    routes(login(), cipher(LOWER_ID)).transport,
  );
  expect(result.items[0]).toMatchObject({
    label: "Lower",
    secretValue: "lower-secret",
  });
});
