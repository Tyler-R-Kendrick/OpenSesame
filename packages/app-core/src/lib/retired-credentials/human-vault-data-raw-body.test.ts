import {
  type SealedBlob,
  bytesToB64,
  importVaultKey,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { gcmSeal } from "@opensesame/vault-core/gcm.js";
import { expect, it } from "vitest";
import { verifyHumanVaultData } from "./human-vault-data.js";
import {
  tomb,
  unavailable,
  useFixture,
} from "./human-vault-data.test-support.js";

/** Actual existing vault-core AEAD; raw JSON is needed to retain malformed tokens. */
async function sealRawBody(
  root: Uint8Array,
  text: string,
): Promise<SealedBlob> {
  const key = await importVaultKey(root);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(text);
  try {
    const body = await gcmSeal(
      key,
      plaintext,
      iv,
      new TextEncoder().encode(vaultSealBinding(tomb, "body")),
    );
    return { ivB64: bytesToB64(iv), ctB64: bytesToB64(body) };
  } finally {
    plaintext.fill(0);
  }
}

it("refuses a genuinely bound fractional revision that JSON.parse would round upward to the outer minimum", () =>
  useFixture(async (value) => {
    const header = JSON.stringify({ ...value.header, bodyRev: 1 });
    const positive = await sealRawBody(
      value.root,
      '{"v":1,"rev":1,"items":[],"folders":[]}',
    );
    await expect(
      verifyHumanVaultData(tomb, header, positive, value.root),
    ).resolves.toMatchObject({ bodyRevision: 1 });
    const malformed = await sealRawBody(
      value.root,
      '{"v":1,"rev":0.99999999999999999,"items":[],"folders":[]}',
    );
    await expect(
      verifyHumanVaultData(tomb, header, malformed, value.root),
    ).rejects.toThrow(unavailable);
    await expect(
      verifyHumanVaultData(tomb, header, positive, value.root),
    ).resolves.toMatchObject({ bodyRevision: 1 });
  }));

it("refuses duplicate authenticated BODY revision declarations rather than reporting only the last parsed value", () =>
  useFixture(async (value) => {
    const header = JSON.stringify(value.header);
    const positive = await sealRawBody(
      value.root,
      '{"v":1,"rev":0,"items":[],"folders":[]}',
    );
    await expect(
      verifyHumanVaultData(tomb, header, positive, value.root),
    ).resolves.toMatchObject({ bodyRevision: 0 });
    const malformed = await sealRawBody(
      value.root,
      '{"v":1,"rev":2,"rev":0,"items":[],"folders":[]}',
    );
    await expect(
      verifyHumanVaultData(tomb, header, malformed, value.root),
    ).rejects.toThrow(unavailable);
    await expect(
      verifyHumanVaultData(tomb, header, positive, value.root),
    ).resolves.toMatchObject({ bodyRevision: 0 });
  }));
