import { mintVaultKey, vaultSealBinding } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import {
  type WebLocksDouble,
  webLocksDouble,
} from "../__tests__/web-locks-double.js";
import { kvDelete } from "../kv.js";
import {
  enrollRetiredCredential,
  flushRetiredCredentialTelemetry,
} from "../retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  PERSONAL_TOMB,
  pinTombAuthority,
  readFile,
  tombFileKey,
  vfsFlush,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import { clearVaultSurface } from "./protection/protector-enrollment.test-support.js";
import { rekeyTomb } from "./seal-rebind.js";
import { vaultStore } from "./store.js";

const PASSWORD = "generated fixture owner password";
const RETIRED = "generated fixture retired password";
const PATH = "settings/rekey-probe";
afterEach(async () => {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await flushRetiredCredentialTelemetry();
  vi.restoreAllMocks();
  vaultStore.lock();
  configureHost(createTestHost());
});

async function originalOwner(): Promise<CryptoKey> {
  configureHost(createTestHost({ locks: webLocksDouble() }));
  vaultStore.lock();
  await clearVaultSurface();
  kvDelete(tombFileKey(PERSONAL_TOMB, "retired-credentials.v1"));
  await vaultStore.create(PASSWORD);
  vaultStore.lock();
  await vaultStore.unlock(PASSWORD);
  await enrollRetiredCredential({
    tomb: PERSONAL_TOMB,
    currentPassword: PASSWORD,
    retiredPassword: RETIRED,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  await flushRetiredCredentialTelemetry();
  let originalKey: CryptoKey | undefined;
  const seal = vfsSeams.seal;
  const capture = vi
    .spyOn(vfsSeams, "seal")
    .mockImplementation((key, value, binding) => {
      if (binding === vaultSealBinding(PERSONAL_TOMB, PATH)) originalKey = key;
      return seal(key, value, binding);
    });
  await writeFile(PERSONAL_TOMB, PATH, new Uint8Array([8, 4, 2]));
  await vfsFlush();
  capture.mockRestore();
  if (!originalKey)
    throw new Error("Genuine admitted fixture key was not captured");
  return originalKey;
}

function barrier() {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release: () => release() };
}

it("refuses a held original rekey after an actual enrolled synthetic session and fresh owner successor", async () => {
  const originalKey = await originalOwner();
  const originalCheck = pinTombAuthority(PERSONAL_TOMB, originalKey);
  const previous = vfsSeams.readRaw(tombFileKey(PERSONAL_TOMB, PATH));
  const next = await mintVaultKey();
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    const ciphertext = await encrypt(...args);
    reached();
    await held;
    return ciphertext;
  });
  const pending = rekeyTomb(PERSONAL_TOMB, originalKey, next.rawVaultKey).then(
    () => null,
    (error: Error) => error,
  );
  let successor: ReturnType<typeof storedSnapshot> | undefined;
  try {
    await started;
    vaultStore.lock();
    expect(await unlockWithRetiredCredentialGate(vaultStore, RETIRED)).toBe(
      "retired_credential_session",
    );
    expect(vaultStore.getSnapshot()).toMatchObject({
      status: "unlocked",
      decoy: true,
      guest: true,
    });
    vaultStore.lock();
    await vaultStore.unlock(PASSWORD);
    expect(vaultStore.getSnapshot()).toMatchObject({
      status: "unlocked",
      guest: false,
    });
    expect(() => originalCheck()).toThrow();
    await writeFile(
      PERSONAL_TOMB,
      "settings/rekey-second",
      new Uint8Array([9, 9]),
    );
    successor = storedSnapshot();
  } finally {
    release();
  }
  const outcome = await pending;
  expect.soft(outcome).toBeInstanceOf(Error);
  expect
    .soft(vfsSeams.readRaw(tombFileKey(PERSONAL_TOMB, PATH)) === previous)
    .toBe(true);
  expect.soft(storedSnapshot()).toEqual(successor);
  vaultStore.lock();
  await vaultStore.unlock(PASSWORD);
  const readable = await readFile(PERSONAL_TOMB, PATH).then(
    () => true,
    () => false,
  );
  expect.soft(readable).toBe(true);
  expect(await readFile(PERSONAL_TOMB, "settings/rekey-second")).toEqual(
    new Uint8Array([9, 9]),
  );
  next.rawVaultKey.fill(0);
});

function storedSnapshot() {
  return Object.fromEntries(
    [PATH, "settings/rekey-second", INDEX_PATH, BODY_PATH, HEADER_PATH].map(
      (path) => [path, vfsSeams.readRaw(tombFileKey(PERSONAL_TOMB, path))],
    ),
  );
}

it("restores exact original ciphertext after an accepted raw write loses its owner", async () => {
  const originalKey = await originalOwner();
  await writeFile(
    PERSONAL_TOMB,
    "settings/rekey-second",
    new Uint8Array([7, 1]),
  );
  const before = storedSnapshot();
  const next = await mintVaultKey();
  const started = barrier();
  const held = barrier();
  const write = vfsSeams.writeRaw;
  let intercepted = false;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, raw) => {
    await write(key, raw);
    if (key === tombFileKey(PERSONAL_TOMB, PATH) && !intercepted) {
      intercepted = true;
      started.release();
      await held.waiting;
    }
  });
  const pending = rekeyTomb(PERSONAL_TOMB, originalKey, next.rawVaultKey).then(
    () => null,
    (error: Error) => error,
  );
  try {
    await started.waiting;
    expect(storedSnapshot()[PATH]).not.toBe(before[PATH]);
    vaultStore.lock();
    expect(await unlockWithRetiredCredentialGate(vaultStore, RETIRED)).toBe(
      "retired_credential_session",
    );
    expect(vaultStore.getSnapshot()).toMatchObject({
      decoy: true,
      guest: true,
    });
  } finally {
    held.release();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(storedSnapshot()).toEqual(before);
  expect(vaultStore.getSnapshot()).toMatchObject({ decoy: true, guest: true });
  await expect(readFile(PERSONAL_TOMB, PATH)).rejects.toMatchObject({
    code: "locked",
  });
  vaultStore.lock();
  await vaultStore.unlock(PASSWORD);
  expect(await readFile(PERSONAL_TOMB, PATH)).toEqual(
    new Uint8Array([8, 4, 2]),
  );
  expect(await readFile(PERSONAL_TOMB, "settings/rekey-second")).toEqual(
    new Uint8Array([7, 1]),
  );
  next.rawVaultKey.fill(0);
});

it("restores a failed partial I/O without changing the original admitted key", async () => {
  const originalKey = await originalOwner();
  const SECOND = "settings/rekey-second";
  await writeFile(PERSONAL_TOMB, SECOND, new Uint8Array([7, 1]));
  const before = storedSnapshot();
  const check = pinTombAuthority(PERSONAL_TOMB, originalKey);
  const next = await mintVaultKey();
  const write = vfsSeams.writeRaw;
  let failed = false;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, raw) => {
    if (key === tombFileKey(PERSONAL_TOMB, SECOND) && !failed) {
      failed = true;
      throw new Error("Generated durable I/O refusal");
    }
    await write(key, raw);
  });
  await expect(
    rekeyTomb(PERSONAL_TOMB, originalKey, next.rawVaultKey),
  ).rejects.toThrow("I/O refusal");
  expect(failed).toBe(true);
  expect(storedSnapshot()).toEqual(before);
  expect(() => check()).not.toThrow();
  expect(await readFile(PERSONAL_TOMB, PATH)).toEqual(
    new Uint8Array([8, 4, 2]),
  );
  next.rawVaultKey.fill(0);
});

it("preserves a genuine peer file write completed during cryptographic preparation", async () => {
  const originalKey = await originalOwner();
  const next = await mintVaultKey();
  const started = barrier();
  const held = barrier();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    const ciphertext = await encrypt(...args);
    started.release();
    await held.waiting;
    return ciphertext;
  });
  const pending = rekeyTomb(PERSONAL_TOMB, originalKey, next.rawVaultKey).then(
    () => null,
    (error: Error) => error,
  );
  let peer: ReturnType<typeof storedSnapshot> | undefined;
  try {
    await started.waiting;
    await writeFile(PERSONAL_TOMB, PATH, new Uint8Array([9, 9]));
    peer = storedSnapshot();
  } finally {
    held.release();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(storedSnapshot()).toEqual(peer);
  expect(await readFile(PERSONAL_TOMB, PATH)).toEqual(new Uint8Array([9, 9]));
  next.rawVaultKey.fill(0);
});

it("withholds completed rekey results when the outer lock return loses its owner", async () => {
  const originalKey = await originalOwner();
  const next = await mintVaultKey();
  const started = barrier();
  const held = barrier();
  const underlying = webLocksDouble();
  const locks: WebLocksDouble = {
    ...underlying,
    async request<T>(
      ...args:
        | [string, () => Promise<T>]
        | [string, LockOptions, (lock: Lock | null) => Promise<T>]
    ): Promise<T> {
      const result =
        args.length === 2
          ? await underlying.request(args[0], args[1])
          : await underlying.request(args[0], args[1], args[2]);
      if (args[0] === `opensesame:vault-body:${PERSONAL_TOMB}`) {
        started.release();
        await held.waiting;
      }
      return result;
    },
  };
  configureHost(createTestHost({ locks }));
  const pending = rekeyTomb(PERSONAL_TOMB, originalKey, next.rawVaultKey).then(
    () => null,
    (error: Error) => error,
  );
  let committed: ReturnType<typeof storedSnapshot> | undefined;
  try {
    await started.waiting;
    expect(await readFile(PERSONAL_TOMB, PATH)).toEqual(
      new Uint8Array([8, 4, 2]),
    );
    committed = storedSnapshot();
    vaultStore.lock();
  } finally {
    held.release();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(storedSnapshot()).toEqual(committed);
  await expect(readFile(PERSONAL_TOMB, PATH)).rejects.toMatchObject({
    code: "locked",
  });
  next.rawVaultKey.fill(0);
});
