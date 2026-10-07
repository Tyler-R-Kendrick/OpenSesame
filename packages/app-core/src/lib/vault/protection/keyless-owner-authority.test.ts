import { overlapCast } from "@opensesame/os-domain";
import { type VaultHeader, randomBytes } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withCredentialObservationOwner } from "../../credential-canaries/owner.js";
import { createControlledCanary } from "../../credential-canaries/registry.js";
import { canaryRegistryKey } from "../../credential-canaries/storage.js";
import { requiresFreshOwnerAuthentication } from "../../decoy-session.js";
import { kvDelete, kvGet } from "../../kv.js";
import {
  retiredCredentialEnrollmentSupported,
  retiredCredentialStorageSeams,
} from "../../retired-credentials/index.js";
import { authenticateRetiredCredentialOwner } from "../../retired-credentials/owner-auth.js";
import {
  PASSWORD,
  TRAPS_KEY,
  createRetiredCredentialFixture,
} from "../../retired-credentials/test-support.js";
import { unlockWithRetiredCredentialGate } from "../../retired-credentials/unlock.js";
import { PERSONAL_TOMB, readFile, writeFile } from "../../vfs.js";
import { unlockMethodsSeams } from "../unlock-methods.js";

const PIN = "73920146";
const CANARIES = canaryRegistryKey(PERSONAL_TOMB);
const owner = { tomb: PERSONAL_TOMB, currentPassword: PASSWORD };
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
const originalCeremony = { ...unlockMethodsSeams };
let currentPrf = new ArrayBuffer(32);

beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  kvDelete(CANARIES);
  unlockMethodsSeams.createPasskeyUnlockCeremony = async () => {
    currentPrf = overlapCast(randomBytes(32).buffer);
    return {
      credential: overlapCast({ rawId: randomBytes(16).buffer }),
      prfOutput: currentPrf,
      prfSalt: randomBytes(16),
      userId: randomBytes(16),
    };
  };
  unlockMethodsSeams.getPasskeyUnlockCeremony = async () => currentPrf;
});
afterEach(() => {
  fixture.restore();
  Object.assign(unlockMethodsSeams, originalCeremony);
  kvDelete(CANARIES);
});

async function removePassword(): Promise<void> {
  await fixture.store.enrollPasskey();
  await fixture.store.removePassword();
  expect(fixture.store.getSnapshot().header?.wrap).toBeUndefined();
}

function assertAdvancedRoot(
  previous: VaultHeader | null,
  current: VaultHeader | null,
): void {
  expect(current?.protection?.vaultId).toBe(previous?.protection?.vaultId);
  expect(current?.protection?.rootEpoch).toBe(
    (previous?.protection?.rootEpoch ?? 0) + 1,
  );
}

it("refuses a password rotation on a passkey-only vault before probing password traps", async () => {
  await removePassword();
  const refreshed: string[] = [];
  retiredCredentialStorageSeams.refresh = async (key) => {
    refreshed.push(key);
  };
  await expect(
    fixture.store.protection.rotateCompromisedRoot({ password: PASSWORD }),
  ).rejects.toThrow(/no master password/);
  expect(refreshed).not.toContain(TRAPS_KEY);
  expect(fixture.store.getSnapshot().header?.wrap).toBeUndefined();
});

it("rotates a keyless vault under PIN bytes matching a retired password without classifying that factor", async () => {
  await fixture.enroll(PIN, "synthetic_decoy");
  const artifact = await createControlledCanary({
    ...owner,
    kind: "connection_ref",
  });
  expect(artifact.context.kind).toBe("connection_ref");
  let staleOwner: () => void = () => {
    throw new Error("Owner proof did not run");
  };
  await withCredentialObservationOwner(owner, async (_identity, check) => {
    staleOwner = check;
  });
  const bytes = new Uint8Array([8, 4, 2, 1]);
  await writeFile(PERSONAL_TOMB, "settings/keyless-owner", bytes);
  const traps = kvGet(TRAPS_KEY);
  const canaries = kvGet(CANARIES);
  await removePassword();
  const staleStore = fixture.store.pinContinuation();
  const oldHeader = fixture.store.getSnapshot().header;
  await fixture.store.protection.rotateCompromisedRoot({ pin: PIN });
  const header = fixture.store.getSnapshot().header;
  assertAdvancedRoot(oldHeader, header);
  expect(header?.wrap).toBeUndefined();
  expect(header?.kdf).toBeUndefined();
  expect(header?.unlocks?.passkey).toBeUndefined();
  expect(header?.unlocks?.pin).toBeDefined();
  expect(() => staleStore()).toThrow(/session changed/);
  expect(() => staleOwner()).toThrow(/owner changed/);
  fixture.store.pinContinuation()();
  expect(retiredCredentialEnrollmentSupported(PERSONAL_TOMB)).toBe(false);
  await expect(
    authenticateRetiredCredentialOwner(PERSONAL_TOMB, PASSWORD),
  ).rejects.toThrow(/password protector/);
  await expect(
    createControlledCanary({ ...owner, kind: "connection_ref" }),
  ).rejects.toThrow(/password protector/);
  expect(kvGet(TRAPS_KEY)).toBe(traps);
  expect(kvGet(CANARIES)).toBe(canaries);
  expect(await readFile(PERSONAL_TOMB, "settings/keyless-owner")).toEqual(
    bytes,
  );
  fixture.store.lock();
  await fixture.store.unlockWithPin(PIN);
  expect(fixture.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: false,
    decoy: false,
  });
  expect(await readFile(PERSONAL_TOMB, "settings/keyless-owner")).toEqual(
    bytes,
  );
  expect(kvGet(TRAPS_KEY)).toBe(traps);
  fixture.store.lock();
  await expect(
    unlockWithRetiredCredentialGate(fixture.store, PIN),
  ).resolves.toBe("retired_credential_session");
  expect(fixture.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: true,
    decoy: true,
  });
  await expect(
    readFile(PERSONAL_TOMB, "settings/keyless-owner"),
  ).rejects.toThrow();
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await expect(fixture.store.unlockWithPin(PIN)).rejects.toThrow();
  fixture.store.lock();
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await expect(fixture.store.unlockWithPin("13572468")).rejects.toThrow();
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  await fixture.store.unlockWithPin(PIN);
  expect(requiresFreshOwnerAuthentication()).toBe(false);
  expect(fixture.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: false,
    decoy: false,
  });
  expect(await readFile(PERSONAL_TOMB, "settings/keyless-owner")).toEqual(
    bytes,
  );
  expect(kvGet(CANARIES)).toBe(canaries);
});
