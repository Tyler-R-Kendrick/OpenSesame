import { overlapCast } from "@opensesame/os-domain";
import { WrongPasswordError, bytesToB64 } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PasskeyUnlockSessionHost,
  probePasskeyCeremony,
  wrapVaultKeyWithCeremony,
} from "./passkey-unlock-session.js";
import { unlockMethodsSeams, unwrapVaultKeyWithPrf } from "./unlock-methods.js";

const original = { ...unlockMethodsSeams };
afterEach(() => Object.assign(unlockMethodsSeams, original));

function wrap(id: string) {
  return { credentialIdB64: id };
}

function host(ids: string[]) {
  const recordFailedUnlock = vi.fn();
  const [first, ...rest] = ids;
  const header = overlapCast({
    unlocks: first ? { passkey: wrap(first) } : {},
    protection: {
      records: rest.map((id) => ({
        kind: "webauthn-prf",
        proofStatus: "verified",
        credentialIdB64: id,
        protectorId: id,
        saltB64: "c2FsdA==",
        wrap: { ivB64: "aXY=", ctB64: "Y3Q=" },
      })),
    },
  });
  const value: PasskeyUnlockSessionHost = overlapCast({
    header: () => header,
    assertNotLockedOut: () => undefined,
    recordFailedUnlock,
  });
  return { value, recordFailedUnlock };
}

it("wraps and unwraps a passkey while preserving only the user ID view", async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const prfOutput = crypto.getRandomValues(new Uint8Array(32)).buffer;
  const userId = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4);
  const record = await wrapVaultKeyWithCeremony(raw, {
    credential: overlapCast({ rawId: new ArrayBuffer(16) }),
    prfOutput,
    prfSalt: crypto.getRandomValues(new Uint8Array(32)),
    userId,
  });
  expect(record.userIdB64).toBe(bytesToB64(new Uint8Array([1, 2, 3])));
  const opened = await unwrapVaultKeyWithPrf(record, prfOutput);
  expect(opened).toEqual(raw);
  opened.fill(0);
  raw.fill(0);
});

describe("probePasskeyCeremony", () => {
  it("names the credential that answered a single-credential vault", async () => {
    Object.assign(unlockMethodsSeams, {
      getPasskeyUnlockCeremony: async () => new ArrayBuffer(32),
    });
    const { value } = host(["a"]);
    await expect(probePasskeyCeremony(value)).resolves.toEqual({
      prfOutput: new ArrayBuffer(32),
      credentialIdB64: "a",
    });
  });

  it("offers only the credentials it was restricted to", async () => {
    const seen: string[][] = [];
    Object.assign(unlockMethodsSeams, {
      getPasskeyUnlockCeremony: async () => new ArrayBuffer(32),
      getPasskeyUnlockCeremonyFor: async (
        records: { credentialIdB64: string }[],
      ) => {
        seen.push(records.map((row) => row.credentialIdB64));
        return {
          prfOutput: new ArrayBuffer(32),
          record: records[0],
          credentialIdB64: records[0]?.credentialIdB64,
        };
      },
    });
    const { value } = host(["a", "b", "c"]);
    const result = await probePasskeyCeremony(value, {
      onlyCredentialIds: ["b", "c"],
    });
    expect(seen).toEqual([["b", "c"]]);
    expect(result.credentialIdB64).toBe("b");
  });

  it("refuses without a miss when the restriction leaves nothing to offer", async () => {
    const { value, recordFailedUnlock } = host(["a"]);
    await expect(
      probePasskeyCeremony(value, { onlyCredentialIds: ["zzz"] }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(recordFailedUnlock).not.toHaveBeenCalled();
  });

  it("counts a vault with no passkey at all", async () => {
    const { value, recordFailedUnlock } = host([]);
    await expect(probePasskeyCeremony(value)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(recordFailedUnlock).toHaveBeenCalledOnce();
  });
});
