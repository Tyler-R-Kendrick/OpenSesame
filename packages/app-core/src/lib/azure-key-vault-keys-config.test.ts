import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AZURE_KEY_VAULT_KEYS_CONFIG_PATH,
  clearAzureKeyVaultKeysConfig,
  readAzureKeyVaultKeysConfig,
  toAzureKeyVaultKeysPublic,
  writeAzureKeyVaultKeysConfig,
} from "./azure-key-vault-keys-config.js";
import { kvDelete } from "./kv.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "./vfs.js";

const VERSIONED_KEY =
  "https://contoso.vault.azure.net/keys/vault-root/0123456789abcdef0123456789abcdef";
const TENANT = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";

describe("azure-key-vault-keys config", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, AZURE_KEY_VAULT_KEYS_CONFIG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  });

  it("seals credentials and hides the secret in the public view", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await expect(
      writeAzureKeyVaultKeysConfig(PERSONAL_TOMB, {
        versionedKeyId: "https://contoso.vault.azure.net/secrets/x/y",
        tenantId: TENANT,
        clientId: CLIENT,
        clientSecret: "secret",
      }),
    ).rejects.toThrow(/Secrets/);
    const saved = await writeAzureKeyVaultKeysConfig(PERSONAL_TOMB, {
      versionedKeyId: VERSIONED_KEY,
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: "super-secret-value",
      label: "Prod wrap",
    });
    expect(saved.versionedKeyId).toBe(VERSIONED_KEY);
    expect(saved.configVersion).toBe("1");
    expect(toAzureKeyVaultKeysPublic(saved)).toEqual({
      versionedKeyId: VERSIONED_KEY,
      tenantId: TENANT,
      clientId: CLIENT,
      hasSecret: true,
      label: "Prod wrap",
      configVersion: "1",
    });
    await expect(readAzureKeyVaultKeysConfig(PERSONAL_TOMB)).resolves.toEqual(
      saved,
    );
    const updated = await writeAzureKeyVaultKeysConfig(PERSONAL_TOMB, {
      versionedKeyId: VERSIONED_KEY,
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: "",
      keepExistingSecret: true,
      label: "Prod wrap 2",
    });
    expect(updated.clientSecret).toBe("super-secret-value");
    expect(updated.configVersion).toBe("2");
    await clearAzureKeyVaultKeysConfig(PERSONAL_TOMB);
    await expect(readAzureKeyVaultKeysConfig(PERSONAL_TOMB)).resolves.toEqual({
      versionedKeyId: "",
      tenantId: "",
      clientId: "",
      clientSecret: "",
      label: null,
      configVersion: "0",
    });
  });
});
