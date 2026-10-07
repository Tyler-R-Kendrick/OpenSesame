import { overlapCast } from "@opensesame/os-domain";
import { randomBytes } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as protectorSession from "../vault/protector-unlock-session.js";
import * as methods from "../vault/unlock-methods.js";
import { createRetiredCredentialFixture } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";

function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
const seams = { ...methods.unlockMethodsSeams };
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll("selected retired password", "synthetic_decoy");
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(methods.unlockMethodsSeams, seams);
  fixture.restore();
});

async function enrollPasskey() {
  const prf = new ArrayBuffer(32);
  crypto.getRandomValues(new Uint8Array(prf));
  methods.unlockMethodsSeams.createPasskeyUnlockCeremony = async () => ({
    credential: overlapCast({ rawId: randomBytes(16).buffer }),
    prfOutput: prf,
    prfSalt: randomBytes(16),
    userId: randomBytes(16),
  });
  methods.unlockMethodsSeams.getPasskeyUnlockCeremony = async () => prf;
  await fixture.store.enrollPasskey();
  fixture.store.lock();
  return prf;
}

it("returns a passkey probe only while its original admission context remains current", async () => {
  const prf = await enrollPasskey();
  const proof = await fixture.store.probePasskeyCeremony();
  expect(proof.prfOutput).toBe(prf);
  expect(proof.credentialIdB64).toBeTruthy();
});

it("wipes a real passkey proof returned after retired synthetic admission", async () => {
  const prf = await enrollPasskey();
  const reached = deferred();
  const blocked = deferred();
  methods.unlockMethodsSeams.getPasskeyUnlockCeremony = async () => {
    reached.finish();
    await blocked.promise;
    return prf;
  };
  const pending = fixture.store.probePasskeyCeremony().then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  await unlockWithRetiredCredentialGate(
    fixture.store,
    "selected retired password",
  );
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await pending).toBeInstanceOf(Error);
  expect(Array.from(new Uint8Array(prf))).toEqual(
    Array.from({ length: 32 }, () => 0),
  );
  expect(fixture.store.getSnapshot()).toEqual(current);
});

it("wipes a real passkey root unwrapped after its original context was replaced", async () => {
  const prf = await enrollPasskey();
  const reached = deferred();
  const blocked = deferred();
  let raw: Uint8Array | null = null;
  const unwrap = methods.unwrapVaultKeyWithPrf;
  vi.spyOn(methods, "unwrapVaultKeyWithPrf").mockImplementationOnce(
    async (...args) => {
      raw = await unwrap(...args);
      reached.finish();
      await blocked.promise;
      return raw;
    },
  );
  const pending = fixture.store.unlockWithHeldPrf(prf).then(
    () => null,
    (error: Error) => error,
  );
  await reached.promise;
  await unlockWithRetiredCredentialGate(
    fixture.store,
    "selected retired password",
  );
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await pending).toBeInstanceOf(Error);
  if (!raw) throw new Error("Expected an actual decrypted real root");
  expect(Array.from(raw)).toEqual(Array.from({ length: 32 }, () => 0));
  expect(fixture.store.getSnapshot()).toEqual(current);
});

it("wipes a real recovery proof whose completed probe reaches a stale continuation", async () => {
  const candidate =
    await fixture.store.protection.enrollCandidate("recovery-key");
  await fixture.store.protection.commitEnrollment(candidate.operationId);
  fixture.store.lock();
  const reached = deferred();
  const blocked = deferred();
  let root: ArrayBuffer | null = null;
  const probe = protectorSession.probeProtectorRoot;
  vi.spyOn(protectorSession, "probeProtectorRoot").mockImplementationOnce(
    async (...args) => {
      root = await probe(...args);
      reached.finish();
      await blocked.promise;
      return root;
    },
  );
  const pending = fixture.store
    .probeProtector({
      method: "recovery",
      secret: candidate.recoverySecretB64 ?? "",
    })
    .then(
      () => null,
      (error: Error) => error,
    );
  await reached.promise;
  await unlockWithRetiredCredentialGate(
    fixture.store,
    "selected retired password",
  );
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await pending).toBeInstanceOf(Error);
  if (!root) throw new Error("Expected an actual opened recovery proof");
  expect(Array.from(new Uint8Array(root))).toEqual(
    Array.from({ length: 32 }, () => 0),
  );
  expect(fixture.store.getSnapshot()).toEqual(current);
});
