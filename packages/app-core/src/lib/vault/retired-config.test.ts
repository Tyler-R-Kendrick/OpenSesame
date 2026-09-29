import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  lockAllTombs,
  readFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  writeFile,
} from "../vfs.js";
import { RETIRED_CONFIG_PATHS } from "./retired-config.js";
import { hydrateAndMigrateTombOnUnlock } from "./tomb-migration.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("retiring connection files nothing reads", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    for (const path of [
      ...RETIRED_CONFIG_PATHS,
      "config/aws-kms",
      INDEX_PATH,
    ]) {
      kvDelete(tombFileKey(PERSONAL_TOMB, path));
    }
  });

  it("removes a saved YubiKey and Azure service principal on unlock, and only those", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await writeFile(
      PERSONAL_TOMB,
      "config/yubikey",
      bytes('{"recipient":"age1yubikey1x"}'),
    );
    await writeFile(
      PERSONAL_TOMB,
      "config/azure-key-vault-keys",
      bytes('{"clientSecret":"sp-canary-secret"}'),
    );
    await writeFile(PERSONAL_TOMB, "config/aws-kms", bytes('{"keep":true}'));

    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);

    for (const path of RETIRED_CONFIG_PATHS) {
      await expect(readFile(PERSONAL_TOMB, path)).rejects.toMatchObject({
        code: "not-found",
      });
    }
    expect(
      new TextDecoder().decode(await readFile(PERSONAL_TOMB, "config/aws-kms")),
    ).toBe('{"keep":true}');
  });

  it("is a lookup, not a failure, on a device that never saved either", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await expect(
      hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB),
    ).resolves.toBeUndefined();
  });
});
