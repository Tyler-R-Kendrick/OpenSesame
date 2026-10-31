import { mintVaultKey } from "@opensesame/vault-core";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { writeTrustedUnlock } from "../trusted-unlock.js";
import { deferred } from "../vault/store-unlock-races.fixture.js";
import {
  BODY_PATH,
  INDEX_PATH,
  TOMBS_REGISTRY_KEY,
  listTombs,
  lockTomb,
  tombFileKey,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import type { SecretFiles } from "./files.js";
import { installFileBackedVfs } from "./install.js";
import { makeMemorySecretFiles } from "./memory.js";

it.each(["file", "index", "registry"] as const)(
  "a physical %s commit cannot publish its mirror after owner withdrawal",
  async (boundary) => {
    const inner = makeMemorySecretFiles();
    const guarded = inner.writeGuarded?.bind(inner);
    if (!guarded) throw new Error("Missing guarded backend fixture");
    const tomb = `metadata-${crypto.randomUUID()}`;
    const path = "config/owned";
    const storageKey =
      boundary === "registry"
        ? TOMBS_REGISTRY_KEY
        : tombFileKey(tomb, boundary === "index" ? INDEX_PATH : path);
    const physicalPath =
      boundary === "registry"
        ? "tombs.json"
        : `${tomb}/${boundary === "index" ? "index" : path}.json`;
    let live = true;
    const files: SecretFiles = {
      ...inner,
      writeGuarded: (file, data, check, options) =>
        guarded(file, data, check, options).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (file === physicalPath) live = false;
            }),
          ),
        ),
    };
    const restore = await installFileBackedVfs(files);
    const { vaultKey, rawVaultKey } = await mintVaultKey();
    rawVaultKey.fill(0);
    unlockTomb(tomb, vaultKey);
    const before = vfsSeams.readRaw(storageKey);
    try {
      await expect(
        writeFile(tomb, path, new TextEncoder().encode("fixture"), () => {
          if (!live) throw new Error("Original owner ended");
        }),
      ).rejects.toThrow(/Original owner ended/);
      // The valid owner already committed these physical bytes; its late completion may not publish cache state.
      expect(inner.snapshot().has(physicalPath)).toBe(true);
      expect(vfsSeams.readRaw(storageKey)).toBe(before);
      expect(listTombs()).not.toContain(tomb);
    } finally {
      lockTomb(tomb);
      restore();
    }
  },
);

it("ordinary metadata support never grants body projection or private IAM support", async () => {
  const previous = vfsSeams.writeOwnedMetadata;
  const inner = makeMemorySecretFiles();
  const restore = await installFileBackedVfs(inner);
  try {
    const write = vfsSeams.writeOwnedMetadata;
    if (!write) throw new Error("Missing guarded metadata writer");
    expect(vfsSeams.writeRawGuarded).toBeUndefined();
    expect(vfsSeams.refreshRaw).toBeUndefined();
    await expect(
      write(tombFileKey("personal", BODY_PATH), "{}", () => {}),
    ).rejects.toThrow(/guarded body projection/);
    await expect(
      writeFile("personal", "config/locked", new Uint8Array(), () => {}),
    ).rejects.toMatchObject({ code: "locked" });
    await expect(
      writeTrustedUnlock("personal", {
        name: "Family",
        threshold: 1,
        memberIds: [`local_${crypto.randomUUID()}`],
      }),
    ).rejects.toThrow(/cannot safely guard/);
    expect(inner.snapshot().size).toBe(0);
  } finally {
    restore();
  }
  expect(vfsSeams.writeOwnedMetadata).toBe(previous);
});

it("an unsupported backend exposes no borrowed metadata or IAM writer", async () => {
  const inner = makeMemorySecretFiles();
  const { writeGuarded: _missing, ...unsupported } = inner;
  const restore = await installFileBackedVfs(unsupported);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const tomb = `unsupported-${crypto.randomUUID()}`;
  unlockTomb(tomb, vaultKey);
  try {
    expect(vfsSeams.writeOwnedMetadata).toBeUndefined();
    expect(vfsSeams.writeRawGuarded).toBeUndefined();
    await expect(
      writeFile(tomb, "config/owned", new Uint8Array(), () => {}),
    ).rejects.toThrow(/cannot commit an original-owner/);
    expect(inner.snapshot().size).toBe(0);
  } finally {
    lockTomb(tomb);
    restore();
  }
});

it("the adapter captures the original backend method and receiver", async () => {
  const inner = makeMemorySecretFiles();
  const guarded = inner.writeGuarded?.bind(inner);
  if (!guarded) throw new Error("Missing guarded backend fixture");
  let calls = 0;
  const files: SecretFiles = {
    ...inner,
    writeGuarded(path, bytes, check, options) {
      expect(this).toBe(files);
      calls++;
      return guarded(path, bytes, check, options);
    },
  };
  const restore = await installFileBackedVfs(files);
  Reflect.set(files, "writeGuarded", () => {
    throw new Error("Replacement backend called");
  });
  try {
    const write = vfsSeams.writeOwnedMetadata;
    if (!write) throw new Error("Missing guarded metadata writer");
    await write("tombs.v1", '{"v":1,"tombs":[]}', () => {});
    expect(calls).toBe(1);
    expect(inner.snapshot().has("tombs.json")).toBe(true);
  } finally {
    restore();
  }
});

it("replacing only the metadata writer during sealing retires the original VFS write", async () => {
  const inner = makeMemorySecretFiles();
  const guarded = inner.writeGuarded?.bind(inner);
  if (!guarded) throw new Error("Missing guarded backend fixture");
  let calls = 0;
  const files: SecretFiles = {
    ...inner,
    writeGuarded: (...args) => {
      calls++;
      return guarded(...args);
    },
  };
  const restore = await installFileBackedVfs(files);
  const tomb = `metadata-transport-${crypto.randomUUID()}`;
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  unlockTomb(tomb, vaultKey);
  const started = deferred();
  const gate = deferred();
  const seal = vfsSeams.seal;
  const spy = vi
    .spyOn(vfsSeams, "seal")
    .mockImplementationOnce(async (...args) => {
      const blob = await seal(...args);
      started.release();
      await gate.promise;
      return blob;
    });
  const writing = writeFile(
    tomb,
    "config/owned",
    new Uint8Array([1]),
    () => {},
  );
  const refused = expect(writing).rejects.toThrow(
    /Original vault transport changed/,
  );
  await started.promise;
  try {
    const original = vfsSeams.writeOwnedMetadata;
    if (!original) throw new Error("Missing guarded metadata writer");
    vfsSeams.writeOwnedMetadata = (...args) => original(...args);
    gate.release();
    await refused;
    expect(calls).toBe(0);
    expect(inner.snapshot().size).toBe(0);
    expect(vfsSeams.readRaw(tombFileKey(tomb, "config/owned"))).toBeNull();
    expect(vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH))).toBeNull();
    expect(listTombs()).not.toContain(tomb);
  } finally {
    gate.release();
    await refused;
    spy.mockRestore();
    lockTomb(tomb);
    restore();
  }
});
