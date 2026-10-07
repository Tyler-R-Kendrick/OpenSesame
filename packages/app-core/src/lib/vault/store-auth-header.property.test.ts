import {
  type VaultHeader,
  mintVaultKey,
  openJson,
  sealJson,
} from "@opensesame/vault-core";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
  assertAuthenticationSession,
  markDecoySession,
} from "../decoy-session.js";
import { kvSet } from "../kv.js";
import { tombFileKey } from "../vfs.js";
import {
  authenticationHeaderWitness,
  publishAuthenticatedSession,
} from "./store-auth-header.js";

it("admits only the original policy across generated before-proof and during-proof changes", async () => {
  const { vaultKey } = await mintVaultKey();
  const plaintext = { proof: "private authenticated owner body" };
  const sealed = await sealJson(vaultKey, plaintext);
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("before_proof", "during_proof"),
      fc.constantFrom("bodyRev", "hint", "createdAt", "wrap"),
      fc.uuid(),
      async (phase, field, unique) => {
        const tomb = `authentication-property-${unique}`;
        const original: VaultHeader = {
          v: 1,
          createdAt: "2026-10-06T00:00:00Z",
          hint: "Original owner reminder",
          bodyRev: 1,
          wrap: sealed,
        };
        const replacement: VaultHeader = { ...original };
        if (field === "bodyRev") replacement.bodyRev = 2;
        if (field === "hint") replacement.hint = unique;
        if (field === "createdAt") replacement.createdAt = unique;
        if (field === "wrap") replacement.wrap = { ...sealed, ctB64: unique };
        const path = tombFileKey(tomb, "header");
        kvSet(path, JSON.stringify(original));
        if (phase === "before_proof") kvSet(path, JSON.stringify(replacement));
        let commits = 0;
        const result = await publishAuthenticatedSession(
          tomb,
          authenticationHeaderWitness(original),
          () => {},
          async () => {
            expect(await openJson(vaultKey, sealed)).toEqual(plaintext);
            if (phase === "during_proof")
              kvSet(path, JSON.stringify(replacement));
          },
          () => {
            commits += 1;
          },
        ).then(
          () => null,
          (error: Error) => error,
        );
        if (field === "bodyRev") {
          expect(result).toBeNull();
          expect(commits).toBe(1);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(commits).toBe(0);
        }
      },
    ),
    { seed: 1731011, numRuns: 24 },
  );
});

it("does not publish authority when the actual AEAD body proof rejects", async () => {
  const { vaultKey } = await mintVaultKey();
  const other = await mintVaultKey();
  const sealed = await sealJson(other.vaultKey, { owner: "another root" });
  const header: VaultHeader = { v: 1, createdAt: "2026-10-06" };
  const tomb = "authentication-property-wrong-root";
  kvSet(tombFileKey(tomb, "header"), JSON.stringify(header));
  let published = false;
  await expect(
    publishAuthenticatedSession(
      tomb,
      authenticationHeaderWitness(header),
      () => {},
      async () => {
        await openJson(vaultKey, sealed);
      },
      () => {
        published = true;
      },
    ),
  ).rejects.toThrow();
  expect(published).toBe(false);
});

it("does not publish a real proof after its realm enters and leaves a synthetic session", async () => {
  const { vaultKey } = await mintVaultKey();
  const sealed = await sealJson(vaultKey, {
    owner: "actual authenticated body",
  });
  const header: VaultHeader = { v: 1, createdAt: "2026-10-06" };
  const tomb = "authentication-property-stale-realm";
  kvSet(tombFileKey(tomb, "header"), JSON.stringify(header));
  const realm = assertAuthenticationSession();
  let published = false;
  await expect(
    publishAuthenticatedSession(
      tomb,
      authenticationHeaderWitness(header),
      () => {
        assertAuthenticationSession(realm);
      },
      async () => {
        await openJson(vaultKey, sealed);
        markDecoySession(true, tomb);
        markDecoySession(false);
      },
      () => {
        published = true;
      },
    ),
  ).rejects.toThrow();
  expect(published).toBe(false);
});
