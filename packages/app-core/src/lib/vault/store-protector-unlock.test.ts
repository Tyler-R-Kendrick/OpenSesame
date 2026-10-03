/**
 * Unlock from an enrolled protector, end to end on the real vault code
 * (ADR 0152): create a vault, enroll through the protection service, lock, and
 * open it again from the manifest's capsule — with the same lockout and
 * second-step guards the password has.
 */
import { WrongPasswordError, createItem } from "@opensesame/vault-core";
import { parseTotp, totpCode } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { generateAgeKeyPair } from "../age-keys.js";
import { kvGet, kvSet } from "../kv.js";
import { LOCK_AFTER_FAILS } from "./store-scope.js";
import { VaultStore } from "./store.js";
import {
  GCP_KEY,
  HEADER_KEY,
  KEY_ARN,
  PASSWORD,
  awsFake,
  clearVaultSurface,
  gcpFake,
} from "./protection/protector-enrollment.test-support.js";
import { enrollTotp } from "./store-totp.fixture.js";

beforeEach(clearVaultSurface);

async function vaultWithItem(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  await store.saveItem(createItem("note", "kept across the lock"));
  await store.flushPendingWrites();
  return store;
}

async function enrollRecovery(store: VaultStore): Promise<string> {
  const candidate = await store.protection.enrollCandidate("recovery-key");
  await store.protection.commitEnrollment(candidate.operationId);
  return candidate.recoverySecretB64 ?? "";
}

async function enrollAge(store: VaultStore): Promise<string> {
  const candidate = await store.protection.enrollExternal({
    kind: "age-recipient",
  });
  await store.protection.commitEnrollment(candidate.operationId);
  return candidate.ageIdentitySecret ?? "";
}

/** A new store over the same files, as a reload would make. */
function reopen(store: VaultStore): VaultStore {
  store.lock();
  return new VaultStore();
}

describe("unlock with an enrolled recovery key", () => {
  it("opens the vault the key was enrolled on, with its items", async () => {
    const store = await vaultWithItem();
    const secret = await enrollRecovery(store);
    const locked = reopen(store);
    expect(locked.getSnapshot().status).toBe("locked");

    await locked.unlockWithProtector({ method: "recovery", secret });

    expect(locked.getSnapshot().status).toBe("unlocked");
    expect(locked.getSnapshot().items.map((item) => item.name)).toEqual([
      "kept across the lock",
    ]);
    expect(locked.getSnapshot().failedAttempts).toBe(0);
  });

  it("takes the shown-once file as it was saved, newline and all", async () => {
    const store = await vaultWithItem();
    const secret = await enrollRecovery(store);
    const locked = reopen(store);
    await locked.unlockWithProtector({
      method: "recovery",
      secret: `  ${secret}\n`,
    });
    expect(locked.getSnapshot().status).toBe("unlocked");
  });

  it("refuses a wrong key and counts it like a wrong password", async () => {
    const store = await vaultWithItem();
    await enrollRecovery(store);
    const locked = reopen(store);
    const wrong = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

    await expect(
      locked.unlockWithProtector({ method: "recovery", secret: wrong }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(locked.getSnapshot().status).toBe("locked");
    expect(locked.getSnapshot().failedAttempts).toBe(1);

    await expect(
      locked.unlockWithProtector({ method: "recovery", secret: "not base64!" }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(
      locked.unlockWithProtector({ method: "recovery", secret: "" }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(locked.getSnapshot().failedAttempts).toBe(3);
  });

  it("locks the screen out after the same number of misses as a password", async () => {
    const store = await vaultWithItem();
    const secret = await enrollRecovery(store);
    const locked = reopen(store);
    for (let miss = 0; miss < LOCK_AFTER_FAILS; miss += 1) {
      await expect(
        locked.unlockWithProtector({ method: "recovery", secret: "AAAA" }),
      ).rejects.toBeInstanceOf(WrongPasswordError);
    }
    expect(locked.getSnapshot().lockedOutUntil).not.toBeNull();
    // The right key is refused while the lockout stands — and so is a password.
    await expect(
      locked.unlockWithProtector({ method: "recovery", secret }),
    ).rejects.toThrow(/Too many attempts/);
    await expect(locked.unlock(PASSWORD)).rejects.toThrow(/Too many attempts/);
    expect(locked.getSnapshot().status).toBe("locked");
  });

  it("is refused with nothing enrolled, and counted, so the screen never says which", async () => {
    const store = await vaultWithItem();
    const locked = reopen(store);
    await expect(
      locked.unlockWithProtector({ method: "recovery", secret: "AAAA" }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(locked.getSnapshot().failedAttempts).toBe(1);
  });

  it("still asks for the authenticator code when one is enrolled", async () => {
    const store = await vaultWithItem();
    const secret = await enrollRecovery(store);
    const totpUri = await enrollTotp(store);
    const seed = new URL(totpUri).searchParams.get("secret") ?? "";
    // Withdraw the vault's own authenticator (ADR 0113) so the code is asked.
    const selfId = store.getSnapshot().header?.unlocks?.totp?.selfItemId ?? "";
    await store.trashItem(selfId);
    const locked = reopen(store);

    await locked.unlockWithProtector({ method: "recovery", secret });
    expect(locked.getSnapshot().status).toBe("locked");
    expect(locked.getSnapshot().awaitingSecondStep).toBe(true);

    await expect(locked.confirmTotp("000000")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(locked.getSnapshot().failedAttempts).toBe(1);
    expect(locked.getSnapshot().status).toBe("locked");

    await locked.confirmTotp(await totpCode(parseTotp(seed)));
    expect(locked.getSnapshot().status).toBe("unlocked");
    expect(locked.getSnapshot().awaitingSecondStep).toBe(false);
  });

  it("opens nothing once the protector is removed", async () => {
    const store = await vaultWithItem();
    const secret = await enrollRecovery(store);
    const [record] = store.protection
      .listProtectors()
      .filter((row) => row.kind === "recovery-key");
    // Another verified path stands (the password), so the row may go.
    await store.protection.removeProtector(record?.protectorId ?? "");
    const locked = reopen(store);
    await expect(
      locked.unlockWithProtector({ method: "recovery", secret }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("opens nothing from a header whose manifest was moved to another vault", async () => {
    const store = await vaultWithItem();
    const secret = await enrollRecovery(store);
    store.lock();
    // The header is plaintext: a manifest edited to name another vault carries
    // capsules whose context no longer matches, and they must open nothing.
    const header = JSON.parse(kvGet(HEADER_KEY) ?? "{}");
    header.protection.vaultId = `${header.protection.vaultId}-other`;
    kvSet(HEADER_KEY, JSON.stringify(header));
    const locked = new VaultStore();
    await expect(
      locked.unlockWithProtector({ method: "recovery", secret }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(locked.getSnapshot().status).toBe("locked");
  });
});

describe("unlock with an enrolled age identity", () => {
  it("opens with the identity that was minted, and refuses another", async () => {
    const store = await vaultWithItem();
    const identity = await enrollAge(store);
    expect(identity.startsWith("AGE-SECRET-KEY-")).toBe(true);
    const locked = reopen(store);

    await expect(
      locked.unlockWithProtector({ method: "age", secret: "AGE-SECRET-KEY-1" }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(locked.getSnapshot().failedAttempts).toBe(1);

    await locked.unlockWithProtector({ method: "age", secret: identity });
    expect(locked.getSnapshot().status).toBe("unlocked");
    expect(locked.getSnapshot().items).toHaveLength(1);
  });

  it("does not offer a pasted recipient until a Test has opened it", async () => {
    const store = await vaultWithItem();
    const pair = await generateAgeKeyPair();
    const pasted = await store.protection.enrollExternal({
      kind: "age-recipient",
      recipients: [pair.recipient],
    });
    await store.protection.commitEnrollment(pasted.operationId);
    expect(pasted.record.proofStatus).toBe("untested");

    const untested = reopen(store);
    await expect(
      untested.unlockWithProtector({ method: "age", secret: pair.identity }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(untested.getSnapshot().status).toBe("locked");

    await untested.unlock(PASSWORD);
    await untested.protection.testProtector(pasted.record.protectorId, {
      ageIdentity: pair.identity,
    });
    const tested = reopen(untested);
    await tested.unlockWithProtector({ method: "age", secret: pair.identity });
    expect(tested.getSnapshot().status).toBe("unlocked");
  });
});

describe("what does not open the vault before it is open", () => {
  it("never reads a cloud record: its credential is sealed in this vault", async () => {
    const store = await vaultWithItem();
    const aws = await store.protection.enrollExternal({
      kind: "aws-kms",
      keyArn: KEY_ARN,
      region: "us-west-2",
      connectionId: "conn",
      connectionConfigVersion: "1",
      transport: awsFake(KEY_ARN),
    });
    await store.protection.commitEnrollment(aws.operationId);
    const gcp = await store.protection.enrollExternal({
      kind: "gcp-kms",
      keyName: GCP_KEY,
      connectionId: "conn",
      connectionConfigVersion: "1",
      transport: gcpFake(),
    });
    await store.protection.commitEnrollment(gcp.operationId);
    const locked = reopen(store);
    for (const method of ["recovery", "age", "agePasskey"] as const) {
      await expect(
        locked.unlockWithProtector({ method, secret: "AAAA" }),
      ).rejects.toBeInstanceOf(WrongPasswordError);
    }
    expect(locked.getSnapshot().status).toBe("locked");
  });
});
