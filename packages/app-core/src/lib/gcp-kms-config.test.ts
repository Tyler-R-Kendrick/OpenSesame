import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GCP_KMS_CONFIG_PATH,
  clearGcpKmsConfig,
  readGcpKmsConfig,
  toGcpKmsPublic,
  writeGcpKmsConfig,
} from "./gcp-kms-config.js";
import { kvDelete } from "./kv.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "./vfs.js";

const KEY_NAME =
  "projects/demo-project/locations/us-central1/keyRings/ring/cryptoKeys/vault-root";
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "wrap@demo-project.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n",
});

describe("gcp-kms config", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, GCP_KMS_CONFIG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  });

  it("seals credentials and hides the secret in the public view", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await expect(
      writeGcpKmsConfig(PERSONAL_TOMB, {
        keyName: "projects/demo",
        serviceAccountJson: SERVICE_ACCOUNT,
      }),
    ).rejects.toThrow(/cryptoKeys/);
    const saved = await writeGcpKmsConfig(PERSONAL_TOMB, {
      keyName: KEY_NAME,
      projectId: "demo-project",
      serviceAccountJson: SERVICE_ACCOUNT,
      label: "Prod wrap",
    });
    expect(saved.keyName).toBe(KEY_NAME);
    expect(saved.projectId).toBe("demo-project");
    expect(saved.configVersion).toBe("1");
    expect(toGcpKmsPublic(saved)).toEqual({
      keyName: KEY_NAME,
      projectId: "demo-project",
      hasSecret: true,
      label: "Prod wrap",
      configVersion: "1",
    });
    await expect(readGcpKmsConfig(PERSONAL_TOMB)).resolves.toEqual(saved);
    const updated = await writeGcpKmsConfig(PERSONAL_TOMB, {
      keyName: KEY_NAME,
      projectId: "demo-project",
      serviceAccountJson: "",
      keepExistingSecret: true,
      label: "Prod wrap 2",
    });
    expect(updated.serviceAccountJson).toBe(SERVICE_ACCOUNT);
    expect(updated.configVersion).toBe("2");
    await clearGcpKmsConfig(PERSONAL_TOMB);
    await expect(readGcpKmsConfig(PERSONAL_TOMB)).resolves.toEqual({
      keyName: "",
      projectId: "",
      serviceAccountJson: "",
      label: null,
      configVersion: "0",
    });
  });
});
