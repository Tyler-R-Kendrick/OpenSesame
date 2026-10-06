import { describe, expect, it } from "vitest";
import {
  VaultCorruptError,
  createVault,
  importVaultKey,
  openJson,
  rewrapVaultKey,
  sealJson,
  unlockVaultKey,
  vaultSealBinding,
} from "./crypto.js";
import { memoryObjectStore, openFile, sealFile } from "./file-parts.js";

describe("customer vault key isolation", () => {
  it("keeps every secret payload and attachment isolated with a shared operator password", async () => {
    const password = "operator fixture password";
    const customerA = await createVault(password);
    const customerB = await createVault(password);
    const store = memoryObjectStore();
    const file = await sealFile({
      name: "customer.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("customer A attachment"),
      stores: [store],
    });
    // Whole-body sealing covers both legacy fields and arbitrary installed types.
    const body = {
      login: { password: "login fixture", totp: "otp seed fixture" },
      passkey: { privateKeyPkcs8B64: "private key fixture" },
      card: { number: "card fixture", code: "code fixture" },
      secret: { value: "api key fixture" },
      note: { notes: "private note fixture" },
      certificate: { privateKey: "certificate key fixture" },
      drop: { payload: "shared secret fixture" },
      typed: { typeId: "customer.custom", values: { token: "custom fixture" } },
      attachment: file,
    };
    const binding = vaultSealBinding("customer-a", "body");
    const sealed = await sealJson(customerA.vaultKey, body, binding);
    await expect(
      openJson(customerB.vaultKey, sealed, binding),
    ).rejects.toBeInstanceOf(VaultCorruptError);
    await expect(
      openJson(
        customerA.vaultKey,
        sealed,
        vaultSealBinding("customer-b", "body"),
      ),
    ).rejects.toBeInstanceOf(VaultCorruptError);

    // Rewrapping a customer's root changes only its protector, leaving its
    // body and the encrypted file objects readable under that customer's key.
    const nextHeader = await rewrapVaultKey(
      customerA.header,
      password,
      "next fixture password",
    );
    const reopened = await unlockVaultKey(nextHeader, "next fixture password");
    await expect(openJson(reopened, sealed, binding)).resolves.toEqual(body);
    await expect(openFile(file, [store])).resolves.toMatchObject({
      bytes: new TextEncoder().encode("customer A attachment"),
    });
    await expect(
      openJson(customerB.vaultKey, sealed, binding),
    ).rejects.toBeInstanceOf(VaultCorruptError);
    customerA.rawVaultKey.fill(0);
    customerB.rawVaultKey.fill(0);
  });

  it.each([0, 16, 24, 31, 33])(
    "refuses a %i-byte vault or file key",
    async (size) => {
      await expect(importVaultKey(new Uint8Array(size))).rejects.toBeInstanceOf(
        VaultCorruptError,
      );
    },
  );
});
