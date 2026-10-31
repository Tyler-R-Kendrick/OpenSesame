import { isPublicKeyCredential } from "@opensesame/sdk-browser";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { readLocalPasskeys } from "./local-credentials.js";
import { changeLocalDirectory } from "./local-directory-admin.js";
import * as signInPrf from "./local-passkey-prf.js";
import {
  authenticateLocalPasskey,
  enrollLocalPasskey,
} from "./local-passkeys.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";

let tomb: string;
let principalId: string;
let device: Awaited<ReturnType<typeof authenticator>>;
beforeEach(async () => {
  tomb = `iam-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  device = await authenticator();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: device,
    locks: webLocksDouble(),
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
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function usablePrf() {
  const original = device.get.bind(device);
  const stable = crypto.getRandomValues(new Uint8Array(32));
  const outputs: Uint8Array[] = [];
  let last: PublicKeyCredential | null = null;
  vi.spyOn(device, "get").mockImplementation(async (options) => {
    const credential = await original(options);
    if (credential && isPublicKeyCredential(credential)) {
      last = credential;
      const output = stable.slice();
      outputs.push(output);
      credential.getClientExtensionResults = () => ({
        prf: { results: { first: output.buffer } },
      });
    }
    return credential;
  });
  return {
    outputs,
    credential() {
      if (!last) throw new Error("No passkey assertion");
      return last;
    },
  };
}

describe("sign-in WebAuthn PRF", () => {
  it("evaluates PRF while the boot owner is unbound, then restores its live binding", async () => {
    const { vaultStore } = await import("./vault/store.js");
    const { installVaultStoreBoot } = await import("./vault/store-boot.js");
    // A released binding is the same empty-owner state as before singleton boot.
    const release = signInPrf.installSignInPrfVault(vaultStore);
    const stateRead = vi.spyOn(vaultStore, "isUnlocked");
    const pendingPlan = signInPrf.prepareSignInPrf(tomb, []);
    release();
    await pendingPlan;
    expect(stateRead).not.toHaveBeenCalled();
    stateRead.mockRestore();
    const prf = usablePrf();
    try {
      await enrollLocalPasskey(tomb, principalId);
      await authenticateLocalPasskey(tomb, principalId);
      expect((await readLocalPasskeys(tomb))[0]?.prfCapable).toBe(true);
      expect(prf.outputs).toHaveLength(1);
      expect(
        prf.outputs.every((output) => output.every((byte) => byte === 0)),
      ).toBe(true);
    } finally {
      installVaultStoreBoot(vaultStore);
    }
  });

  it("records PRF capability when sign-in evaluates a usable result", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const original = device.get.bind(device);
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      const credential = await original(options);
      if (credential && "getClientExtensionResults" in credential) {
        const output = crypto.getRandomValues(new Uint8Array(32));
        credential.getClientExtensionResults = () => ({
          prf: { results: { first: output.buffer } },
        });
      }
      return credential;
    });
    await authenticateLocalPasskey(tomb, principalId);
    expect((await readLocalPasskeys(tomb))[0]?.prfCapable).toBe(true);
  });

  it("wraps the open vault with the sign-in PRF output", async () => {
    const { vaultStore } = await import("./vault/store.js");
    await vaultStore.create("correct horse battery staple");
    const directory = await changeLocalDirectory(vaultStore.activeTomb(), 0, {
      action: "create",
      kind: "person",
      name: "Vault person",
    });
    const person = directory.entries[0];
    if (!person) throw new Error("No person");
    await enrollLocalPasskey(vaultStore.activeTomb(), person.id);
    const prf = usablePrf();
    const enroll = vi.spyOn(vaultStore.protection, "enrollHeldWebauthnPrf");
    try {
      await authenticateLocalPasskey(vaultStore.activeTomb(), person.id);
      const heldPrf = enroll.mock.calls[0]?.[0].prfOutput;
      if (!heldPrf) throw new Error("Held PRF was not passed to enrollment");
      expect(new Uint8Array(heldPrf).every((byte) => byte === 0)).toBe(true);
      expect(
        vaultStore.protection
          .listProtectors()
          .some((record) => record.kind === "webauthn-prf"),
      ).toBe(true);
      const before = vaultStore.protection.listProtectors();
      const plan = await signInPrf.prepareSignInPrf(
        vaultStore.activeTomb(),
        await readLocalPasskeys(vaultStore.activeTomb()),
      );
      expect([...plan.plan.values()].every((row) => row.existing)).toBe(true);
      signInPrf.zeroSignInPrfSalts(plan.plan);
      await authenticateLocalPasskey(vaultStore.activeTomb(), person.id);
      expect(vaultStore.protection.listProtectors()).toEqual(before);
      expect(prf.outputs).toHaveLength(2);
      expect(
        prf.outputs.every((output) => output.every((byte) => byte === 0)),
      ).toBe(true);
      enroll.mockClear();
      const commit = vi.spyOn(vaultStore.protection, "commitEnrollment");
      const keys = await readLocalPasskeys(vaultStore.activeTomb());
      const otherTomb = `${vaultStore.activeTomb()}-other`;
      const otherPlan = await signInPrf.prepareSignInPrf(otherTomb, keys);
      expect([...otherPlan.plan.values()].every((row) => !row.existing)).toBe(
        true,
      );
      const output = crypto.getRandomValues(new Uint8Array(32));
      const credential = prf.credential();
      credential.getClientExtensionResults = () => ({
        prf: { results: { first: output.buffer } },
      });
      expect(
        await signInPrf.applySignInPrf(
          otherTomb,
          person.id,
          credential,
          otherPlan.plan,
        ),
      ).toBe(true);
      expect(
        [...otherPlan.plan.values()].every((row) =>
          row.salt.every((byte) => byte === 0),
        ),
      ).toBe(true);
      const lockedPlan = await signInPrf.prepareSignInPrf(
        vaultStore.activeTomb(),
        keys,
      );
      output.set(crypto.getRandomValues(new Uint8Array(32)));
      const applying = signInPrf.applySignInPrf(
        vaultStore.activeTomb(),
        person.id,
        credential,
        lockedPlan.plan,
      );
      vaultStore.lock();
      expect(await applying).toBe(true);
      expect(enroll).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(output.every((byte) => byte === 0)).toBe(true);
      expect(
        [...lockedPlan.plan.values()].every((row) =>
          row.salt.every((byte) => byte === 0),
        ),
      ).toBe(true);
    } finally {
      vaultStore.lock();
      await vaultStore.destroy();
    }
  });
});
