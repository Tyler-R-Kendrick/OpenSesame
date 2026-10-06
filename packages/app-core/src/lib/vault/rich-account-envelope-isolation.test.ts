import { overlapCast } from "@opensesame/os-domain";
import {
  type AccountItem,
  DEFAULT_RULES,
  type VaultBody,
  createItem,
  importVaultKey,
  openJson,
  pepperBinding,
  sealWithPepper,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { atRestBinding, openAtRest } from "../at-rest/cipher.js";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { kvForgetAll } from "../kv.js";
import { BODY_PATH, PERSONAL_TOMB, readSealedFile, vfsFlush } from "../vfs.js";
import { VaultStore } from "./store.js";

const PASSWORD = "same password for both independent customers";
const OPRF_KEY = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
const SECRETS = [
  "plain-password-canary",
  "peppered-password-canary",
  "api-key-canary",
  "bearer-token-canary",
  "oauth-client-canary",
  "oauth-refresh-canary",
  "JBSWY3DPEHPK3PXP",
  OPRF_KEY,
];

function originFiles(files: Map<string, string>): FileSystemDirectoryHandle {
  const root = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create)
        throw new DOMException("Missing", "NotFoundError");
      return {
        getFile: async () => new Blob([files.get(name) ?? ""]),
        createWritable: async () => ({
          write: async (text: string) => {
            files.set(name, text);
          },
          close: async () => {},
        }),
      };
    },
    removeEntry: async (name: string) => {
      files.delete(name);
    },
  };
  return overlapCast(root);
}

async function richAccount(): Promise<AccountItem> {
  const account = createItem("account", "Shared account IDs");
  account.id = "same-account-id";
  account.username = "same-user";
  const changedAt = account.updatedAt;
  account.methods = [
    {
      id: "plain",
      type: "password",
      generator: { id: "manual" },
      pepper: false,
      secret: SECRETS[0],
      changedAt,
    },
    {
      id: "peppered",
      type: "password",
      generator: { id: "manual" },
      pepper: true,
      secret: "",
      sealed: await sealWithPepper(
        SECRETS[1],
        "same pepper",
        pepperBinding(account.id, "peppered"),
      ),
      changedAt,
    },
    {
      id: "sphinx",
      type: "password",
      generator: {
        id: "sphinx",
        rules: { ...DEFAULT_RULES },
        realm: "example.test",
        counter: 0,
        oprfKeyB64: OPRF_KEY,
      },
      pepper: true,
      secret: "",
      changedAt,
    },
    { id: "api", type: "api-key", key: SECRETS[2], header: "X-Api-Key" },
    { id: "token", type: "token", token: SECRETS[3], expiresAt: "" },
    {
      id: "oauth",
      type: "oauth",
      clientId: "client",
      clientSecret: SECRETS[4],
      refreshToken: SECRETS[5],
      tokenUrl: "https://example.test/token",
      scopes: "openid",
    },
    { id: "totp", type: "authenticator", secret: SECRETS[6] },
  ];
  return account;
}

async function persistCustomer(rootByte: number, account: AccountItem) {
  await vfsFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  const files = new Map<string, string>();
  const root = new Uint8Array(32).fill(rootByte);
  const handle = originFiles(files);
  configureHost(
    createTestHost({
      originFiles: () => Promise.resolve(handle),
      atRestKeys: { loadSync: () => root, load: async () => root },
    }),
  );
  const store = new VaultStore();
  await store.create(PASSWORD);
  await store.saveItem(account);
  await store.flushPendingWrites();
  await vfsFlush();
  const header = store.getSnapshot().header;
  const body = readSealedFile(PERSONAL_TOMB, BODY_PATH);
  if (!header || !body) throw new Error("Vault failed to persist");
  const key = await importVaultKey(
    await unwrapRawVaultKeyFromPassword(header, PASSWORD),
  );
  store.lock();
  return { files, root, key, body };
}

afterEach(async () => {
  await vfsFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
});

it("protects every new account secret across independent customer vaults with equal IDs and passwords", async () => {
  const account = await richAccount();
  const alpha = await persistCustomer(31, account);
  const beta = await persistCustomer(32, account);
  const binding = vaultSealBinding(PERSONAL_TOMB, BODY_PATH);
  const opened = await openJson<VaultBody>(alpha.key, alpha.body, binding);
  expect(opened.items[0]).toMatchObject({
    id: account.id,
    methods: account.methods,
  });
  expect(
    (await openJson<VaultBody>(beta.key, beta.body, binding)).items[0],
  ).toMatchObject({ id: account.id, methods: account.methods });
  expect(alpha.body).not.toEqual(beta.body);
  await expect(openJson(beta.key, alpha.body, binding)).rejects.toThrow();
  await expect(
    openJson(
      alpha.key,
      alpha.body,
      vaultSealBinding("other-customer", BODY_PATH),
    ),
  ).rejects.toThrow();
  await expect(
    openJson(alpha.key, { ...alpha.body, ctB64: beta.body.ctB64 }, binding),
  ).rejects.toThrow();
  for (const customer of [alpha, beta]) {
    expect(customer.files.size).toBeGreaterThan(0);
    const vaultBytes = Buffer.from(customer.body.ctB64, "base64");
    for (const secret of SECRETS)
      expect(vaultBytes.includes(Buffer.from(secret))).toBe(false);
    for (const [name, ciphertext] of customer.files) {
      expect(ciphertext).toMatch(/^osr2\./);
      for (const secret of SECRETS) expect(ciphertext).not.toContain(secret);
      const recordBinding = atRestBinding("origin-file", name);
      expect(
        openAtRest(customer.root, recordBinding, ciphertext),
      ).not.toBeNull();
      expect(
        openAtRest(
          customer === alpha ? beta.root : alpha.root,
          recordBinding,
          ciphertext,
        ),
      ).toBeNull();
      expect(
        openAtRest(
          customer.root,
          atRestBinding("origin-file", `${name}.other-customer`),
          ciphertext,
        ),
      ).toBeNull();
      const bytes = Buffer.from(ciphertext.slice(5), "base64url");
      for (const secret of SECRETS)
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  }
}, 30_000);
