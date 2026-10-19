import { createItem, readVaultFile } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { vaultStore } from "../vault/store.js";
import {
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "./backup-transfer.js";
import {
  NATIVE_LIMITS,
  NATIVE_PASSWORD,
  nativeHttpFixture,
} from "./bitwarden-native-http.test-support.js";
import {
  type BitwardenNativeConfiguration,
  createBitwardenNativeBackend,
} from "./bitwarden-native.js";
import { runtimeFixture, runtimePassword } from "./runtime.test-support.js";

it.each([false, true])(
  "stores, reads back and restores a real sealed local vault through native encrypted HTTP modern=%s",
  async (modern) => {
    const local = await runtimeFixture();
    const provider = await nativeHttpFixture(modern);
    const backend = createBitwardenNativeBackend(
      provider.transport,
      NATIVE_LIMITS,
    );
    const config: BitwardenNativeConfiguration = {
      providerId: modern ? "bitwarden" : "vaultwarden",
      name: "Native backup",
      mode: "bitwarden-api",
      ...provider.credentials,
      accountEmail: provider.credentials.email,
      masterPassword: NATIVE_PASSWORD,
      token: "",
      vaultId: "",
      projectId: "",
      organizationId: "",
      environment: "",
      secretPath: "",
      passwordListId: "",
      fileFormat: "",
    };
    const session = await backend.authenticate(config);
    try {
      const source = createItem("secret", "Native original item");
      source.value = "native-backup-plaintext-source-secret";
      await vaultStore.saveItem(source);
      const open = { backend, session };
      const reference = await backUpVaultToSecretBackend(
        open,
        "Native ciphertext vault backup",
      );
      const stored = await backend.getItem(reference.id, session);
      expect(readVaultFile(stored.notes).body.ctB64).toBeTruthy();
      expect(provider.decoded.get(reference.id)?.get("notes")).toBe(
        stored.notes,
      );
      for (const request of provider.requests.filter(
        (record) =>
          record.path.startsWith("/api/ciphers") && record.method !== "GET",
      )) {
        expect(request.body).not.toContain(source.value);
        expect(request.body).not.toContain(runtimePassword);
        expect(request.body).not.toContain(NATIVE_PASSWORD);
        expect(request.body).not.toContain("opensesame-offline-backup");
      }
      await vaultStore.trashItem(source.id);
      await vaultStore.purgeItem(source.id);
      const later = createItem("note", "Preserve later local item");
      later.notes = "Retain through native restore";
      await vaultStore.saveItem(later);
      await expect(
        restoreVaultFromSecretBackend(open, reference.id, "wrong-password"),
      ).rejects.toThrow();
      expect(
        await restoreVaultFromSecretBackend(
          open,
          reference.id,
          runtimePassword,
        ),
      ).toBe(1);
      expect(vaultStore.getSnapshot().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: source.id, value: source.value }),
          expect.objectContaining({ id: later.id, notes: later.notes }),
        ]),
      );
      expect(
        await restoreVaultFromSecretBackend(
          open,
          reference.id,
          runtimePassword,
        ),
      ).toBe(0);
    } finally {
      await backend.disconnect(session);
      await provider.close();
      await local.close();
    }
  },
);
