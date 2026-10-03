/**
 * A capsule sealed to a public age recipient needs no secret to make, and the
 * context inside it is public, so anyone who can write the header can build one
 * around a root of their choosing (ADR 0152). The opened root must therefore
 * verify the manifest's root-derived MAC, or it is not this vault's.
 */
import {
  WrongPasswordError,
  createItem,
  randomBytes,
} from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvGet, kvSet } from "../kv.js";
import { publishUntestedAgeRecipient } from "./protection/adapters/age-recipient.js";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
} from "./protection/manifest-auth.js";
import {
  HEADER_KEY,
  PASSWORD,
  clearVaultSurface,
} from "./protection/protector-enrollment.test-support.js";
import { VaultStore } from "./store.js";

beforeEach(clearVaultSurface);

async function ageVault() {
  const store = new VaultStore();
  await store.create(PASSWORD);
  await store.saveItem(createItem("note", "kept across the lock"));
  await store.flushPendingWrites();
  const candidate = await store.protection.enrollExternal({
    kind: "age-recipient",
  });
  await store.protection.commitEnrollment(candidate.operationId);
  store.lock();
  const header = JSON.parse(kvGet(HEADER_KEY) ?? "{}");
  const manifest = header.protection;
  const index = manifest.records.findIndex(
    (row: { kind: string }) => row.kind === "age-recipient",
  );
  const record = manifest.records[index];
  /** A capsule to the vault's real recipient, around a root nobody enrolled. */
  const forgedRecord = async (rootKey: Uint8Array) => {
    const forged = await publishUntestedAgeRecipient({
      context: {
        vaultId: manifest.vaultId,
        rootKeyId: manifest.rootKeyId,
        rootEpoch: manifest.rootEpoch,
        protectorId: record.protectorId,
        purpose: manifest.purpose,
      },
      rootKey,
      recipients: record.recipients,
      protectorId: record.protectorId,
    });
    return { ...record, capsuleAgeB64: forged.capsuleAgeB64 };
  };
  return {
    identity: candidate.ageIdentitySecret ?? "",
    header,
    manifest,
    index,
    forgedRecord,
    write: () => kvSet(HEADER_KEY, JSON.stringify(header)),
  };
}

async function expectRefused(identity: string): Promise<void> {
  const locked = new VaultStore();
  await expect(
    locked.unlockWithProtector({ method: "age", secret: identity }),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(locked.getSnapshot().status).toBe("locked");
  expect(locked.getSnapshot().failedAttempts).toBe(1);
}

describe("a forged age capsule", () => {
  it("opens with the real identity when nothing was touched", async () => {
    const { identity } = await ageVault();
    const locked = new VaultStore();
    await locked.unlockWithProtector({ method: "age", secret: identity });
    expect(locked.getSnapshot().status).toBe("unlocked");
  });

  it("is refused when it replaces the capsule in an authenticated manifest", async () => {
    const f = await ageVault();
    f.manifest.records[f.index] = await f.forgedRecord(randomBytes(32));
    f.write();
    await expectRefused(f.identity);
  });

  it("is refused when the whole manifest is rewritten under the forger's root", async () => {
    const f = await ageVault();
    const rootOfTheirChoosing = randomBytes(32);
    const records = [...f.manifest.records];
    records[f.index] = await f.forgedRecord(rootOfTheirChoosing);
    f.header.protection = await sealAuthenticatedManifest(rootOfTheirChoosing, {
      ...manifestWithoutAuth(f.manifest),
      records,
    });
    f.write();
    // The manifest now verifies under the forger's root, so only the vault's
    // own body can refuse it, and it does: that root opens nothing.
    const locked = new VaultStore();
    await expect(
      locked.unlockWithProtector({ method: "age", secret: f.identity }),
    ).rejects.toThrow();
    expect(locked.getSnapshot().status).toBe("locked");
  });
});
