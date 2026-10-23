import { describe, expect, it } from "vitest";
import { createVault } from "./crypto.js";
import {
  buildOfflineBackupEnvelope,
  parseOfflineBackupEnvelope,
  serializeOfflineBackupEnvelope,
} from "./offline-backup-format.js";

const PASSWORD = "correct horse battery staple";

async function envelope() {
  const { header } = await createVault(PASSWORD);
  return buildOfflineBackupEnvelope({
    header: { ...header, bodyRev: 1 },
    body: { ivB64: "iv", ctB64: "ciphertext" },
    syncBlobs: [{ id: "blob-1", epoch: 2, ciphertextB64: "sealed" }],
  });
}

describe("offline backup format", () => {
  it("reads exactly what it writes", async () => {
    const written = await envelope();
    const parsed = parseOfflineBackupEnvelope(
      serializeOfflineBackupEnvelope(written),
    );
    expect(parsed).toEqual(written);
  });

  it("refuses a body the writer would not have produced", async () => {
    const written = await envelope();
    const text = JSON.stringify({
      ...written,
      vault: { header: written.vault.header, body: { ivB64: "iv", ctB64: "" } },
    });
    expect(() => parseOfflineBackupEnvelope(text)).toThrow(
      /missing sealed vault/i,
    );
  });

  it("rejects malformed sync blob metadata on both sides", async () => {
    const base = await envelope();
    expect(() =>
      buildOfflineBackupEnvelope({
        header: base.vault.header,
        body: base.vault.body,
        syncBlobs: [{ id: "", epoch: 1, ciphertextB64: "x" }],
      }),
    ).toThrow(/malformed sync blob/i);
    const text = JSON.stringify({
      ...base,
      syncBlobs: [{ id: "blob-1", epoch: -1, ciphertextB64: "sealed" }],
    });
    expect(() => parseOfflineBackupEnvelope(text)).toThrow(
      /malformed sync blob/i,
    );
  });
});
