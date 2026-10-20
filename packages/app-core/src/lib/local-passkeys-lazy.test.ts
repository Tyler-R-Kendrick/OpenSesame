import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import { readLocalPasskeys, revokeLocalPasskey } from "./local-credentials.js";
import { changeLocalDirectory } from "./local-directory-admin.js";
import { bindLocalIamLockResets } from "./local-iam-lock-resets.js";
import { localPasskeyVerifierSeams } from "./local-passkey-ceremony.js";
import * as signInPrf from "./local-passkey-prf.js";
import {
  authenticateLocalPasskey,
  consumeLocalAuthentication,
  enrollLocalPasskey,
} from "./local-passkeys.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

let tomb: string;
let principalId: string;
let vaultKey: CryptoKey;
let device: Awaited<ReturnType<typeof authenticator>>;
let unbindLockResets: () => void;

beforeEach(async () => {
  unbindLockResets = bindLocalIamLockResets();
  tomb = `lazy-passkey-${crypto.randomUUID()}`;
  vaultKey = (await mintVaultKey()).vaultKey;
  unlockTomb(tomb, vaultKey);
  device = await authenticator();
  let queue = Promise.resolve();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: device,
    locks: {
      request: <T>(_name: string, run: () => Promise<T>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  const directory = await changeLocalDirectory(tomb, 0, {
    action: "create",
    kind: "person",
    name: "Local person",
  });
  const person = directory.entries[0];
  if (!person) throw new Error("No person");
  principalId = person.id;
});

afterEach(() => {
  unbindLockResets();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function hold() {
  let release: () => void = () => {
    throw new Error("Missing held promise");
  };
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release: () => release() };
}

function holdVerifier() {
  const entered = hold();
  const gate = hold();
  const realLoad = localPasskeyVerifierSeams.load;
  const load = vi
    .spyOn(localPasskeyVerifierSeams, "load")
    .mockImplementation(async () => {
      entered.release();
      await gate.pending;
      return realLoad();
    });
  return { entered: entered.pending, release: gate.release, load };
}

async function disablePerson() {
  await changeLocalDirectory(tomb, 1, {
    action: "update",
    id: principalId,
    name: "Local person",
    enabled: false,
  });
}

describe("lazy local passkey verifier with real cryptographic verification", () => {
  it("never loads the verifier when the human cancels creation or assertion", async () => {
    const load = vi.spyOn(localPasskeyVerifierSeams, "load");
    vi.spyOn(navigator.credentials, "create").mockResolvedValueOnce(null);
    await expect(enrollLocalPasskey(tomb, principalId)).rejects.toThrow(
      "cancelled",
    );
    expect(load).not.toHaveBeenCalled();
    await enrollLocalPasskey(tomb, principalId);
    load.mockClear();
    vi.spyOn(navigator.credentials, "get").mockResolvedValueOnce(null);
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "cancelled",
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("loads only after a signed assertion, then verifies and advances its actual counter", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const get = vi.spyOn(device, "get");
    const held = holdVerifier();
    const pending = authenticateLocalPasskey(tomb, principalId, "A".repeat(43));
    await held.entered;
    expect(get).toHaveResolved();
    expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(0);
    held.release();
    const evidence = await pending;
    expect(consumeLocalAuthentication(evidence, "A".repeat(43))).toBe(evidence);
    expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(1);
  });

  it.each(["disabled", "revoked", "expired", "reset"] as const)(
    "refuses authentication %s while the real verifier load is held",
    async (withdrawal) => {
      const enrolled = await enrollLocalPasskey(tomb, principalId);
      const held = holdVerifier();
      const pending = authenticateLocalPasskey(
        tomb,
        principalId,
        "A".repeat(43),
      );
      await held.entered;
      const refusal = expect(pending).rejects.toThrow(
        withdrawal === "reset" ? "no longer valid" : withdrawal,
      );
      try {
        if (withdrawal === "disabled") await disablePerson();
        if (withdrawal === "revoked")
          await revokeLocalPasskey(tomb, principalId, enrolled.credentialId);
        if (withdrawal === "expired")
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
        if (withdrawal === "reset") {
          vaultStore.lock();
          unlockTomb(tomb, vaultKey);
        }
      } finally {
        held.release();
      }
      await refusal;
      const keys = await readLocalPasskeys(tomb);
      if (withdrawal === "revoked") expect(keys).toEqual([]);
      else expect(keys[0]?.counter).toBe(withdrawal === "reset" ? 1 : 0);
    },
  );

  it.each(["disabled", "expired"] as const)(
    "refuses enrollment %s while the real verifier load is held",
    async (withdrawal) => {
      const held = holdVerifier();
      const pending = enrollLocalPasskey(tomb, principalId);
      await held.entered;
      const refusal = expect(pending).rejects.toThrow(withdrawal);
      try {
        if (withdrawal === "disabled") await disablePerson();
        else vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
      } finally {
        held.release();
      }
      await refusal;
      expect(await readLocalPasskeys(tomb)).toEqual([]);
    },
  );

  it("zeroes every planned PRF salt if loading fails after the human assertion", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const realPrepare = signInPrf.prepareSignInPrf;
    let salts: Uint8Array[] = [];
    vi.spyOn(signInPrf, "prepareSignInPrf").mockImplementation(
      async (...args) => {
        const prepared = await realPrepare(...args);
        salts = [...prepared.plan.values()].map((row) => row.salt);
        return prepared;
      },
    );
    vi.spyOn(localPasskeyVerifierSeams, "load").mockRejectedValue(
      new Error("load unavailable"),
    );
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "load unavailable",
    );
    expect(salts).toHaveLength(1);
    expect(salts.every((salt) => salt.every((byte) => byte === 0))).toBe(true);
    expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(0);
  });
});
