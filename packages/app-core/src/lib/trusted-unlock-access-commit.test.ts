import {
  mintVaultKey,
  openJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { deferred, withFixture } from "./kv.entry-lifecycle.test-support.js";
import { kvFileName, kvGet, kvRefresh } from "./kv.js";
import { readLocalPasskeys } from "./local-credentials.js";
import {
  advanceLocalPasskeyCounter,
  createTrustedUnlockAccess,
} from "./local-iam-access.js";
import { installFileBackedVfs } from "./secret-fs/install.js";
import { makeMemorySecretFiles } from "./secret-fs/memory.js";
import { readTrustedUnlock, writeTrustedUnlock } from "./trusted-unlock.js";
import { captureAuthenticationStorage } from "./vault/authentication-storage.js";
import { type TombIndex, parseSealedBlob } from "./vfs-metadata-data.js";
import {
  INDEX_PATH,
  lockTomb,
  tombFileKey,
  tombUnlocked,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "./vfs.js";

const CREDENTIALS = "config/identity-credentials";
const ID = "registered-credential";

async function seed() {
  const tomb = `iam-commit-${crypto.randomUUID()}`;
  const { vaultKey: key, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  unlockTomb(tomb, key);
  try {
    await writeFile(
      tomb,
      CREDENTIALS,
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          passkeys: [
            {
              principalId: `local_${crypto.randomUUID()}`,
              credentialId: ID,
              publicKeyB64: "AA",
              counter: 0,
              createdAt: Date.now(),
            },
          ],
        }),
      ),
    );
  } finally {
    lockTomb(tomb);
  }
  return {
    tomb,
    key,
    credentials: tombFileKey(tomb, CREDENTIALS),
    index: tombFileKey(tomb, INDEX_PATH),
  };
}

async function revision(scope: Awaited<ReturnType<typeof seed>>) {
  await kvRefresh(scope.index, 8 * 1024 * 1024);
  const raw = kvGet(scope.index);
  if (!raw) throw new Error("Missing actual sealed index");
  const value = await openJson<TombIndex>(
    scope.key,
    parseSealedBlob(raw, scope.tomb, INDEX_PATH),
    vaultSealBinding(scope.tomb, INDEX_PATH),
  );
  return value.files[CREDENTIALS];
}

it.each(["credentials", "index"] as const)(
  "cancel during the default durable %s write cannot publish bytes after cancellation",
  (boundary) =>
    withFixture(async (root) => {
      const scope = await seed();
      const entered = deferred();
      const resume = deferred();
      const target = kvFileName(scope[boundary]);
      root.hooks.write = async (name) => {
        if (name === target) {
          entered.resolve();
          await resume.promise;
        }
      };
      const context = createTrustedUnlockAccess(
        scope.tomb,
        scope.key,
        () => {},
      );
      const writing = advanceLocalPasskeyCounter(
        context.access,
        scope.tomb,
        ID,
        0,
        1,
      );
      const refused = expect(writing).rejects.toMatchObject({ code: "locked" });
      await entered.promise;
      const credentials = root.files.get(kvFileName(scope.credentials));
      const index = root.files.get(kvFileName(scope.index));
      try {
        context.revoke();
        resume.resolve();
        await refused;
        expect(root.files.get(kvFileName(scope.credentials))).toBe(credentials);
        expect(root.files.get(kvFileName(scope.index))).toBe(index);
        expect(root.events).toContain(`abort:${target}`);
        expect(tombUnlocked(scope.tomb)).toBe(false);
      } finally {
        resume.resolve();
        await Promise.allSettled([writing]);
        context.revoke();
      }
    }),
);

it("a legacy transport cannot borrow the default guarded writer or enable an unsafe policy", async () => {
  const priorGuard = vfsSeams.writeRawGuarded;
  const restore = await installFileBackedVfs(makeMemorySecretFiles());
  const { vaultKey: key, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const tomb = `legacy-iam-${crypto.randomUUID()}`;
  const context = createTrustedUnlockAccess(tomb, key, () => {});
  try {
    expect(vfsSeams.writeRawGuarded).toBeUndefined();
    await vfsSeams.writeRaw(tombFileKey(tomb, "header"), "{}");
    expect(vfsSeams.readRaw(tombFileKey(tomb, "header"))).toBe("{}");
    await expect(readTrustedUnlock(tomb, context.access)).resolves.toBeNull();
    await expect(
      advanceLocalPasskeyCounter(context.access, tomb, ID, 0, 1),
    ).rejects.toThrow(/cannot safely guard/);
    await expect(
      writeTrustedUnlock(tomb, {
        name: "Family",
        threshold: 1,
        memberIds: [`local_${crypto.randomUUID()}`],
      }),
    ).rejects.toThrow(/cannot safely guard/);
    expect(
      vfsSeams.readRaw(tombFileKey(tomb, "config/trusted-unlock")),
    ).toBeNull();
    await expect(
      captureAuthenticationStorage(tomb, () => {}).read(),
    ).rejects.toThrow(/Fresh ciphertext reads are unavailable/);
  } finally {
    context.revoke();
    restore();
  }
  expect(vfsSeams.writeRawGuarded).toBe(priorGuard);
});

it("a valid physical close cannot revive cached IAM bytes after its owner retires", () =>
  withFixture(async (root) => {
    const scope = await seed();
    const beforeMemory = kvGet(scope.credentials);
    const beforePhysical = root.files.get(kvFileName(scope.credentials));
    const context = createTrustedUnlockAccess(scope.tomb, scope.key, () => {});
    const acquire = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, options) => {
      const handle = await acquire(name, options);
      if (name !== kvFileName(scope.credentials)) return handle;
      return {
        ...handle,
        async createWritable() {
          const writer = await handle.createWritable();
          return {
            ...writer,
            async close() {
              await writer.close();
              queueMicrotask(context.revoke);
            },
          };
        },
      };
    };
    try {
      await expect(
        advanceLocalPasskeyCounter(context.access, scope.tomb, ID, 0, 1),
      ).rejects.toMatchObject({ code: "locked" });
      // The write committed while valid; its later promise completion may not publish into retired memory.
      expect(root.files.get(kvFileName(scope.credentials))).not.toBe(
        beforePhysical,
      );
      expect(kvGet(scope.credentials)).toBe(beforeMemory);
      expect(tombUnlocked(scope.tomb)).toBe(false);
    } finally {
      context.revoke();
    }
  }));

it.each(["credentials", "index"] as const)(
  "a replaced owner blocked at %s cannot overwrite the new counter or index revision",
  (boundary) =>
    withFixture(async (root) => {
      const scope = await seed();
      const initialRevision = await revision(scope);
      const entered = deferred();
      const resume = deferred();
      const target = kvFileName(scope[boundary]);
      let held = false;
      root.hooks.write = async (name) => {
        if (name === target && !held) {
          held = true;
          entered.resolve();
          await resume.promise;
        }
      };
      const old = createTrustedUnlockAccess(scope.tomb, scope.key, () => {});
      const writing = advanceLocalPasskeyCounter(
        old.access,
        scope.tomb,
        ID,
        0,
        1,
      );
      const refused = expect(writing).rejects.toMatchObject({ code: "locked" });
      await entered.promise;
      const next = createTrustedUnlockAccess(scope.tomb, scope.key, () => {});
      old.revoke();
      // At the index boundary the first counter was durably consumed while its owner was valid.
      const expectedCounter = boundary === "index" ? 1 : 0;
      const replacement = advanceLocalPasskeyCounter(
        next.access,
        scope.tomb,
        ID,
        expectedCounter,
        2,
      );
      const fulfilled = expect(replacement).resolves.toBeUndefined();
      try {
        resume.resolve();
        await Promise.all([refused, fulfilled]);
        expect(
          (await readLocalPasskeys(scope.tomb, next.access))[0]?.counter,
        ).toBe(2);
        expect(await revision(scope)).toBe((initialRevision ?? 0) + 1);
        expect(root.events).toContain(`abort:${target}`);
        expect(tombUnlocked(scope.tomb)).toBe(false);
      } finally {
        resume.resolve();
        await Promise.allSettled([writing, replacement]);
        old.revoke();
        next.revoke();
      }
    }),
);
