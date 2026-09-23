import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AWS_KMS_CONFIG_PATH,
  clearAwsKmsConfig,
  readAwsKmsConfig,
  toAwsKmsPublic,
  writeAwsKmsConfig,
} from "./aws-kms-config.js";
import { kvDelete } from "./kv.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "./vfs.js";

const KEY_ARN =
  "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";

describe("aws-kms config", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, AWS_KMS_CONFIG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  });

  it("seals credentials and hides the secret in the public view", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await expect(
      writeAwsKmsConfig(PERSONAL_TOMB, {
        keyArn: "arn:aws:kms:us-east-1:123456789012:alias/prod",
        accessKeyId: "AKIATESTACCESSKEY1",
        secretAccessKey: "secret",
      }),
    ).rejects.toThrow(/alias/);
    const saved = await writeAwsKmsConfig(PERSONAL_TOMB, {
      keyArn: KEY_ARN,
      accessKeyId: "AKIATESTACCESSKEY1",
      secretAccessKey: "super-secret-value",
      sessionToken: "temp-token",
      label: "Prod wrap",
    });
    expect(saved.keyArn).toBe(KEY_ARN);
    expect(saved.region).toBe("us-east-1");
    expect(saved.configVersion).toBe("1");
    expect(toAwsKmsPublic(saved)).toEqual({
      keyArn: KEY_ARN,
      region: "us-east-1",
      accessKeyId: "AKIATESTACCESSKEY1",
      hasSecret: true,
      hasSessionToken: true,
      label: "Prod wrap",
      configVersion: "1",
    });
    await expect(readAwsKmsConfig(PERSONAL_TOMB)).resolves.toEqual(saved);
    const updated = await writeAwsKmsConfig(PERSONAL_TOMB, {
      keyArn: KEY_ARN,
      accessKeyId: "AKIATESTACCESSKEY1",
      secretAccessKey: "",
      keepExistingSecret: true,
      label: "Prod wrap 2",
    });
    expect(updated.secretAccessKey).toBe("super-secret-value");
    expect(updated.configVersion).toBe("2");
    expect(updated.label).toBe("Prod wrap 2");
    await clearAwsKmsConfig(PERSONAL_TOMB);
    await expect(readAwsKmsConfig(PERSONAL_TOMB)).resolves.toEqual({
      keyArn: "",
      region: "",
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: null,
      label: null,
      configVersion: "0",
    });
  });
});
