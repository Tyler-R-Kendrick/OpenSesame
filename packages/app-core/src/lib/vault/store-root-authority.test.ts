import {
  type VaultHeader,
  importVaultKey,
  mintVaultKey,
} from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import {
  assertAuthenticationSession,
  markDecoySession,
} from "../decoy-session.js";
import { kvDelete, kvSet } from "../kv.js";
import { recordKeyAdmission } from "../vfs-authority.js";
import {
  assertRootGeneration,
  recordRootGeneration,
} from "../vfs-root-admission.js";
import { pinTombAuthority, tombFileKey, unlockTomb } from "../vfs.js";
import { sealAuthenticatedManifest } from "./protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./protection/migrate-legacy.js";
import { refreshStoredRootProof } from "./store-root-authority.js";

async function fixture(mismatch?: "storage" | "owner" | "manifest") {
  const tomb = `root-proof-${crypto.randomUUID()}`;
  const { rawVaultKey: raw, vaultKey: actual } = await mintVaultKey();
  const other = await mintVaultKey();
  const owner = mismatch === "owner" ? other.vaultKey : actual;
  const storage =
    mismatch === "storage" ? other.vaultKey : await importVaultKey(raw);
  const header: VaultHeader = { v: 1, createdAt: "2026-10-06" };
  const path = tombFileKey(tomb, "header");
  const previous = JSON.stringify(header);
  kvSet(path, previous);
  unlockTomb(tomb, storage);
  recordKeyAdmission(owner);
  recordRootGeneration(tomb, owner, previous);
  const protection = await sealAuthenticatedManifest(
    mismatch === "manifest" ? other.rawVaultKey : raw,
    migrateLegacyHeaderToManifest({ header }).manifest,
  );
  const current = JSON.stringify({ ...header, protection });
  kvSet(path, current);
  const realm = assertAuthenticationSession();
  const check = () => {
    assertAuthenticationSession(realm);
  };
  return { tomb, raw, owner, storage, path, current, check };
}

it("refreshes both independently imported keys only after authenticating their actual common root", async () => {
  const proof = await fixture();
  await refreshStoredRootProof(
    proof.tomb,
    proof.owner,
    () => proof.raw,
    proof.check,
  );
  expect(pinTombAuthority(proof.tomb)).toBeTypeOf("function");
  expect(() =>
    assertRootGeneration(proof.tomb, proof.owner, proof.current),
  ).not.toThrow();
});

it.each(["storage", "owner", "manifest"] as const)(
  "does not refresh generations when the actual %s root differs",
  async (mismatch) => {
    const proof = await fixture(mismatch);
    await expect(
      refreshStoredRootProof(
        proof.tomb,
        proof.owner,
        () => proof.raw,
        proof.check,
      ),
    ).rejects.toThrow();
    expect(() =>
      assertRootGeneration(proof.tomb, proof.owner, proof.current),
    ).toThrow();
    expect(() => pinTombAuthority(proof.tomb)).toThrow();
  },
);

it.each(["missing", "corrupt", "unauthenticated"] as const)(
  "cannot turn a %s stored header into common-root authority",
  async (fault) => {
    const proof = await fixture();
    if (fault === "missing") kvDelete(proof.path);
    if (fault === "corrupt") kvSet(proof.path, "{");
    if (fault === "unauthenticated")
      kvSet(proof.path, JSON.stringify({ v: 1, createdAt: "2026-10-07" }));
    await expect(
      refreshStoredRootProof(
        proof.tomb,
        proof.owner,
        () => proof.raw,
        proof.check,
      ),
    ).rejects.toThrow();
    expect(() =>
      assertRootGeneration(proof.tomb, proof.owner, proof.current),
    ).toThrow();
    expect(() => pinTombAuthority(proof.tomb)).toThrow();
  },
);

it.each(["realm", "map", "header"] as const)(
  "rejects a genuine pending MAC proof after its original %s changes",
  async (change) => {
    const proof = await fixture();
    const successor = await importVaultKey(proof.raw);
    let reached = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = crypto.subtle.sign.bind(crypto.subtle);
    const spy = vi
      .spyOn(crypto.subtle, "sign")
      .mockImplementationOnce(async (...args) => {
        const tag = await original(...args);
        reached();
        await blocked;
        return tag;
      });
    const result = refreshStoredRootProof(
      proof.tomb,
      proof.owner,
      () => proof.raw,
      proof.check,
    ).then(
      () => null,
      (error: Error) => error,
    );
    await started;
    if (change === "realm") {
      markDecoySession(true, proof.tomb);
      markDecoySession(false);
    }
    if (change === "map") unlockTomb(proof.tomb, successor);
    if (change === "header")
      kvSet(proof.path, proof.current.replace("2026-10-06", "2026-10-07"));
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(() =>
      assertRootGeneration(proof.tomb, proof.owner, proof.current),
    ).toThrow();
    spy.mockRestore();
  },
);
