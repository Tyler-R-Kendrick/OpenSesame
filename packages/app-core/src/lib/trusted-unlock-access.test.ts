import {
  importVaultKey,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { kvDelete } from "./kv.js";
import { authenticator, origin } from "./local-authenticator.fixture.js";
import { readLocalPasskeys } from "./local-credentials.js";
import { changeLocalDirectory } from "./local-directory-admin.js";
import { readLocalDirectory } from "./local-directory.js";
import {
  type LocalIamAccess,
  advanceLocalPasskeyCounter,
  checkLocalIamAccess,
  createTrustedUnlockAccess,
  readLocalIamFile,
} from "./local-iam-access.js";
import {
  authenticateLocalPasskey,
  consumeLocalAuthentication,
  enrollLocalPasskey,
} from "./local-passkeys.js";
import {
  readTrustedUnlock,
  trustedUnlockView,
  writeTrustedUnlock,
} from "./trusted-unlock.js";
import {
  PASSWORD,
  installStoreOperationsFixture,
  newStore,
} from "./vault/store-ops.fixture.js";
import {
  BODY_PATH,
  INDEX_PATH,
  lockTomb,
  readFile,
  readSealedFile,
  tombFileKey,
  tombUnlocked,
  vfsSeams as transport,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "./vfs.js";

installStoreOperationsFixture();
const revocations: Array<() => void> = [];
beforeEach(() => {
  for (const path of [
    "config/trusted-unlock",
    "config/identity-directory",
    "config/identity-credentials",
  ])
    kvDelete(tombFileKey("personal", path));
});
afterEach(() => {
  for (const revoke of revocations.splice(0)) revoke();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("an ordinary unlock without a configured quorum does not require guarded IAM writes", async () => {
  const source = newStore();
  await source.create(PASSWORD);
  source.lock();
  const prior = transport.writeRawGuarded;
  Reflect.deleteProperty(transport, "writeRawGuarded");
  const store = newStore();
  try {
    await store.unlock(PASSWORD);
    expect(store.isUnlocked()).toBe(true);
    expect(store.getSnapshot().trustedUnlock).toBeNull();
  } finally {
    store.lock();
    if (prior) transport.writeRawGuarded = prior;
  }
});

async function prepared() {
  const store = newStore();
  await store.create(PASSWORD);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", new URL(origin));
  vi.stubGlobal("navigator", {
    credentials: await authenticator(),
    locks: webLocksDouble(),
  });
  const directory = await changeLocalDirectory("personal", 0, {
    action: "create",
    kind: "person",
    name: "Contact",
  });
  const person = directory.entries.find((row) => row.kind === "person");
  if (!person) throw new Error("Missing genuine contact");
  await enrollLocalPasskey("personal", person.id);
  await writeTrustedUnlock("personal", {
    name: "Family",
    threshold: 1,
    memberIds: [person.id],
  });
  await writeFile(
    "personal",
    "settings/private-marker",
    new TextEncoder().encode("sealed marker"),
  );
  const header = store.getSnapshot().header;
  if (!header) throw new Error("Missing actual vault header");
  const raw = await unwrapRawVaultKeyFromPassword(header, PASSWORD);
  let key: CryptoKey;
  try {
    key = await importVaultKey(raw);
  } finally {
    raw.fill(0);
  }
  store.lock();
  let live = true;
  const issue = () => {
    const context = createTrustedUnlockAccess("personal", key, () => {
      if (!live) throw new Error("Original owner ended");
    });
    revocations.push(context.revoke);
    return context;
  };
  return {
    store,
    person,
    key,
    issue,
    end: () => {
      live = false;
    },
  };
}

it("reads only IAM while ordinary VFS, body and settings remain locked", async () => {
  const scope = await prepared();
  const { access } = scope.issue();
  const policy = await readTrustedUnlock("personal", access);
  expect(policy?.threshold).toBe(1);
  if (!policy) throw new Error("Missing sealed policy");
  expect(
    (await trustedUnlockView("personal", policy, [], access)).members,
  ).toEqual([{ id: scope.person.id, name: "Contact" }]);
  expect((await readLocalDirectory("personal", access)).entries).toHaveLength(
    1,
  );
  expect(await readLocalPasskeys("personal", access)).toHaveLength(1);
  expect(tombUnlocked("personal")).toBe(false);
  await expect(readFile("personal", BODY_PATH)).rejects.toMatchObject({
    code: "locked",
  });
  await expect(
    readFile("personal", "settings/private-marker"),
  ).rejects.toMatchObject({ code: "locked" });
});

it.each([
  BODY_PATH,
  INDEX_PATH,
  "config/prefs",
  "settings/private-marker",
  "config/../identity-directory",
])("refuses private access to %s", async (path) => {
  const { access } = (await prepared()).issue();
  await expect(
    readLocalIamFile(access, "personal", path),
  ).rejects.toMatchObject({ code: "invalid-path" });
});

it("refuses forged, wrong-tomb and revoked handles", async () => {
  const { access, revoke } = (await prepared()).issue();
  // SAFETY: deliberately forged opaque input tests the runtime WeakMap boundary.
  const forged = {} as LocalIamAccess;
  expect(() => checkLocalIamAccess(forged, "personal")).toThrow(
    /operation ended/,
  );
  await expect(
    readLocalIamFile(access, "guest", "config/identity-directory"),
  ).rejects.toMatchObject({ code: "locked" });
  revoke();
  await expect(
    readLocalIamFile(access, "personal", "config/identity-directory"),
  ).rejects.toMatchObject({ code: "locked" });
});

it("drops a completed decrypted read when its owner revokes before return", async () => {
  const scope = await prepared();
  let started = () => {};
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = vfsSeams.open;
  vi.spyOn(vfsSeams, "open").mockImplementationOnce(async (...args) => {
    const value = await open(...args);
    started();
    await held;
    return value;
  });
  const { access, revoke } = scope.issue();
  const read = readLocalIamFile(access, "personal", "config/trusted-unlock");
  const refused = expect(read).rejects.toMatchObject({ code: "locked" });
  await ready;
  revoke();
  release();
  await refused;
  expect(tombUnlocked("personal")).toBe(false);
});

it.each(["owner", "transport"])(
  "permanently retires a handle after its %s changes",
  async (boundary) => {
    const scope = await prepared();
    const { access } = scope.issue();
    if (boundary === "owner") {
      scope.end();
      expect(() => checkLocalIamAccess(access, "personal")).toThrow(
        /owner ended/,
      );
    } else {
      const read = vfsSeams.readRaw;
      const spy = vi
        .spyOn(vfsSeams, "readRaw")
        .mockImplementation((key) => read(key));
      expect(() => checkLocalIamAccess(access, "personal")).toThrow(
        /transport changed/,
      );
      spy.mockRestore();
    }
    expect(() => checkLocalIamAccess(access, "personal")).toThrow(
      /operation ended/,
    );
  },
);

it("verifies a real passkey and persists its counter without opening VFS or issuing an IAM session", async () => {
  const scope = await prepared();
  const { access } = scope.issue();
  const before = await readLocalPasskeys("personal", access);
  const proof = await authenticateLocalPasskey(
    "personal",
    scope.person.id,
    undefined,
    access,
  );
  const after = await readLocalPasskeys("personal", access);
  expect(after[0]?.counter).toBeGreaterThan(before[0]?.counter ?? -1);
  expect(after.map(({ counter: _, ...key }) => key)).toEqual(
    before.map(({ counter: _, ...key }) => key),
  );
  expect(tombUnlocked("personal")).toBe(false);
  await expect(
    readFile("personal", "settings/private-marker"),
  ).rejects.toMatchObject({ code: "locked" });
  // Even after a later authorized activation, approval evidence is not sign-in evidence.
  unlockTomb("personal", scope.key);
  try {
    expect(() => consumeLocalAuthentication(proof)).toThrow(/no longer valid/);
  } finally {
    lockTomb("personal");
  }
});

it("cancel after a genuine assertion prevents counter publication", async () => {
  const scope = await prepared();
  const { access, revoke } = scope.issue();
  const before = JSON.stringify(
    readSealedFile("personal", "config/identity-credentials"),
  );
  const get = navigator.credentials.get.bind(navigator.credentials);
  vi.spyOn(navigator.credentials, "get").mockImplementationOnce(
    async (options) => {
      const proof = await get(options);
      revoke();
      return proof;
    },
  );
  await expect(
    authenticateLocalPasskey("personal", scope.person.id, undefined, access),
  ).rejects.toMatchObject({ code: "locked" });
  expect(
    JSON.stringify(readSealedFile("personal", "config/identity-credentials")),
  ).toBe(before);
  expect(tombUnlocked("personal")).toBe(false);
});

it.each([-1, 0.5, 0x1_0000_0000])(
  "rejects invalid counter %s without changing credentials",
  async (next) => {
    const { access } = (await prepared()).issue();
    const rows = await readLocalPasskeys("personal", access);
    const row = rows[0];
    if (!row) throw new Error("Missing actual credential");
    const before = JSON.stringify(
      readSealedFile("personal", "config/identity-credentials"),
    );
    await expect(
      advanceLocalPasskeyCounter(
        access,
        "personal",
        row.credentialId,
        row.counter,
        next,
      ),
    ).rejects.toThrow(/counter is invalid/);
    expect(
      JSON.stringify(readSealedFile("personal", "config/identity-credentials")),
    ).toBe(before);
  },
);
