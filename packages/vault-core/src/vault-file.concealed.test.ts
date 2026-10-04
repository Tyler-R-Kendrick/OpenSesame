/**
 * A vault file lists the device identity key by name and never by value
 * (ADR 0160 §5): the path appears, nothing of the key does.
 */
import { describe, expect, it } from "vitest";
import { createVault, sealJson, vaultSealBinding } from "./crypto.js";
import { DEVICE_IDENTITY_KEY_PATH, deviceKeyField } from "./device-key.js";
import { emptyBody } from "./model.js";
import {
  buildOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "./offline-backup-format.js";
import { openVaultFile } from "./vault-file.js";

const PASSWORD = "correct horse battery staple";
const SECRET = "d-private-half-that-must-never-print";

async function backup(withKey: boolean): Promise<string> {
  const { header, vaultKey } = await createVault(PASSWORD);
  const body = {
    ...emptyBody(),
    rev: 1,
    ...(withKey
      ? {
          deviceIdentityKey: deviceKeyField({
            version: 1,
            keyId: "A".repeat(43),
            publicJwk: { kty: "EC", crv: "P-256", x: "px", y: "py" },
            privateJwkJson: JSON.stringify({ d: SECRET }),
            createdAt: 1_700_000_000_000,
          }),
        }
      : undefined),
  };
  const sealed = await sealJson(
    vaultKey,
    body,
    vaultSealBinding("personal", "body"),
  );
  return serializeOfflineBackupEnvelope(
    buildOfflineBackupEnvelope({
      header: { ...header, bodyRev: 1 },
      body: sealed,
    }),
  );
}

describe("listing a vault file that carries the device identity key", () => {
  it("names the path and none of the key", async () => {
    const opened = await openVaultFile(await backup(true), PASSWORD);
    expect(opened.concealed).toEqual([DEVICE_IDENTITY_KEY_PATH]);
    const printed = JSON.stringify(opened);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain("privateJwkJson");
    expect(printed).not.toContain("px");
    // The key is not an item: it is not counted among them.
    expect(opened.items).toEqual([]);
  });

  it("lists nothing concealed when the vault carries no key", async () => {
    const opened = await openVaultFile(await backup(false), PASSWORD);
    expect(opened.concealed).toEqual([]);
  });
});
