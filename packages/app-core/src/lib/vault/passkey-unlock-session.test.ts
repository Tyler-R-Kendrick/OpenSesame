import { overlapCast } from "@opensesame/os-domain";
import { WrongPasswordError } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PasskeyUnlockSessionHost,
  probePasskeyCeremony,
} from "./passkey-unlock-session.js";
import { unlockMethodsSeams } from "./unlock-methods.js";

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
