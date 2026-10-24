import { beforeEach, expect, test } from "vitest";
/** Store mutation entry points must exclude retained hashes before publishing any current credential. */
import { configureHost, host } from "../../host.js";
import { kvFlush, kvForgetAll } from "../kv.js";
import { vfsFlush } from "../vfs.js";
import { withNewVaultScopeGuard } from "./new-vault-scope-guard.js";
import {
  OWNER_PASSWORD,
  retiredOwnerFixture,
} from "./retired-owner.fixture.js";
import { VaultStore } from "./store.js";
beforeEach(async () => {
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
});
const retired = "9382751946048271";
/**
 * The locks an open session holds once an operation settles: only its shared
 * open lease (store.ts `#acquireSessionLease`), never a credential or body
 * write lock.
 */
const openSessionLocks = (store: VaultStore) => [
  `opensesame:vault-open:${store.activeTomb()}`,
];
async function fixture() {
  const f = await retiredOwnerFixture();
  try {
    const result = await f.store.beginRetired(
      { kind: "password", secret: OWNER_PASSWORD },
      {
        kind: "change",
        change: { type: "enroll", password: retired, response: "reject" },
      },
    );
    if (result.kind !== "complete") throw new Error("Unexpected factor.");
    return f;
  } catch (cause) {
    f.dispose();
    throw cause;
  }
}
test("new creation cannot replace an existing locked owner vault", async () => {
  const f = await fixture();
  try {
    const before = f.store.getSnapshot();
    await expect(f.store.create(retired)).rejects.toThrow("already exists");
    await expect(f.store.createWithPin(retired)).rejects.toThrow(
      "already exists",
    );
    expect(f.store.getSnapshot()).toEqual(before);
    expect(f.store.isUnlocked()).toBe(false);
    expect(f.held).toEqual([]);
  } finally {
    await f.store.flushPendingWrites();
    await vfsFlush();
    f.dispose();
  }
});
test("current password replacement cannot reuse a retained credential", async () => {
  const f = await fixture();
  try {
    await f.store.unlock(OWNER_PASSWORD);
    const before = f.store.getSnapshot();
    await expect(
      f.store.changeMasterPassword(OWNER_PASSWORD, retired),
    ).rejects.toThrow("retained");
    expect(f.store.getSnapshot()).toEqual(before);
    expect(f.held).toEqual(openSessionLocks(f.store));
    // The lease is the session's: locking lets it go.
    f.store.lock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.held).toEqual([]);
  } finally {
    await f.store.flushPendingWrites();
    await vfsFlush();
    f.dispose();
  }
});
test("unlocked owner cannot enroll retained password or PIN as an ordinary alternate", async () => {
  const f = await fixture();
  try {
    await f.store.unlock(OWNER_PASSWORD);
    expect(f.store.isGenuineSession()).toBe(true);
    const before = f.store.getSnapshot();
    await expect(f.store.enrollPassword(retired)).rejects.toThrow("retained");
    await expect(f.store.enrollPin(retired)).rejects.toThrow("retained");
    expect(f.store.getSnapshot()).toEqual(before);
    expect(f.store.isGenuineSession()).toBe(true);
    expect(f.held).toEqual(openSessionLocks(f.store));
  } finally {
    await f.store.flushPendingWrites();
    await vfsFlush();
    f.dispose();
  }
});

function emptyScopeStore(
  f: Awaited<ReturnType<typeof retiredOwnerFixture>>,
  rootIdentity = "original-fixture-profile",
  header: string | null = null,
  body: string | null = null,
) {
  kvForgetAll();
  configureHost({
    ...host(),
    physicalVaultAuthentication: {
      bodyFormat: "flat-v1",
      capture: async (tomb, original) => {
        const check = () => {
          original();
          expect(f.held).toContain("opensesame.retired-credentials");
          expect(f.held).toContain(`opensesame:vault-body:${tomb}`);
        };
        return {
          check,
          readOriginalStateIdentity: async () => rootIdentity,
          revalidateRoot: async () => check(),
          read: async () => {
            check();
            return { tomb, header, body };
          },
          close: async () => check(),
        };
      },
    },
  });
  return new VaultStore();
}
test("empty selected scope still refuses global retained password and PIN before new publication", async () => {
  const f = await fixture();
  const store = emptyScopeStore(f);
  try {
    await expect(store.create(retired)).rejects.toThrow("retained");
    await expect(store.createWithPin(retired)).rejects.toThrow("retained");
    expect(store.isUnlocked()).toBe(false);
    expect(f.held).toEqual([]);
  } finally {
    store.lock();
    f.dispose();
  }
});
test("genuinely empty physical selected scope permits creation and intentional owner activation", async () => {
  const f = await retiredOwnerFixture();
  const store = emptyScopeStore(f);
  try {
    await store.create("fresh original owner password security 39746");
    expect(store.isGenuineSession()).toBe(true);
    expect(store.getSnapshot().status).toBe("unlocked");
    expect(f.held).toEqual(openSessionLocks(store));
    expect(f.closed()).toBeGreaterThan(0);
  } finally {
    await store.flushPendingWrites();
    await vfsFlush();
    store.lock();
    f.dispose();
  }
});

test("cached empty creation refuses actual partial physical vault and mismatched root", async () => {
  const f = await retiredOwnerFixture();
  const partial = emptyScopeStore(
    f,
    "original-fixture-profile",
    null,
    "original encrypted body",
  );
  try {
    await expect(
      partial.create("fresh owner password security 52847"),
    ).rejects.toThrow("already exists");
    expect(partial.isUnlocked()).toBe(false);
    expect(f.held).toEqual([]);
    const foreign = emptyScopeStore(f, "foreign-profile");
    try {
      await expect(
        foreign.create("fresh owner password security 52847"),
      ).rejects.toThrow("roots differ");
      expect(foreign.isUnlocked()).toBe(false);
    } finally {
      foreign.lock();
    }
  } finally {
    partial.lock();
    f.dispose();
  }
});
test("standalone creation retains CRED but releases selected BODY and readers before publication", async () => {
  const f = await retiredOwnerFixture();
  const store = emptyScopeStore(f);
  let published = false;
  try {
    await withNewVaultScopeGuard(
      "personal",
      () => {},
      async (check) => {
        check();
        expect(f.held).toEqual(["opensesame.retired-credentials"]);
        expect(f.closed()).toBeGreaterThan(0);
        published = true;
      },
    );
    expect(published).toBe(true);
    expect(f.held).toEqual([]);
  } finally {
    store.lock();
    f.dispose();
  }
});
