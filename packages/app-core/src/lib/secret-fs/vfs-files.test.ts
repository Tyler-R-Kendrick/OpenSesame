import {
  type VaultBody,
  createItem,
  emptyBody,
  mintVaultKey,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { BODY_PATH, TOMBS_REGISTRY_KEY } from "../vfs.js";
import { SecretFsUnavailable } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { makeMemorySecretFiles } from "./memory.js";
import { readProjection } from "./projection-read.js";
import { createFileBackedVfs } from "./vfs-files.js";

const BODY_KEY = `tomb/t/${BODY_PATH}`;
const binding = vaultSealBinding("t", BODY_PATH);
const run = <A>(effect: Effect.Effect<A, SecretFsError>) =>
  Effect.runPromise(effect);

async function sealed(key: CryptoKey, body: VaultBody) {
  return JSON.stringify(await sealJson(key, body, binding));
}

const withItems = (rev: number, ...names: string[]): VaultBody => ({
  ...emptyBody(),
  rev,
  items: names.map((name) => ({
    ...createItem("note", name),
    id: `id-${name}`,
  })),
});

async function adapter(files: SecretFiles = makeMemorySecretFiles()) {
  const vfs = createFileBackedVfs(files);
  await vfs.hydrate();
  return { files, vfs };
}

describe("the VFS over a secret file store", () => {
  it("keeps header, config and registry as one file each and gives them back after hydrate", async () => {
    const { files, vfs } = await adapter();
    await vfs.seams.writeRaw("tomb/t/header", "H");
    await vfs.seams.writeRaw("tomb/t/config/prefs", "P");
    await vfs.seams.writeRaw(TOMBS_REGISTRY_KEY, "R");
    expect(await run(files.list(""))).toEqual([
      "t/config/prefs.json",
      "t/header.json",
      "tombs.json",
    ]);

    const next = createFileBackedVfs(files);
    expect(next.seams.readRaw("tomb/t/header")).toBeNull();
    await next.hydrate();
    expect(next.seams.readRaw("tomb/t/header")).toBe("H");
    expect(next.seams.readRaw("tomb/t/config/prefs")).toBe("P");
    expect(next.seams.readRaw(TOMBS_REGISTRY_KEY)).toBe("R");
  });

  it("refuses names the layout keeps for itself and keys that are not vault files", async () => {
    const { vfs } = await adapter();
    for (const key of [
      "tomb/t/vault",
      "tomb/t/secrets/x",
      "tomb/t/secrets",
      "vault",
      "tomb/t",
      "tomb//x",
    ]) {
      await expect(vfs.seams.writeRaw(key, "x")).rejects.toMatchObject({
        _tag: "SecretFsRejected",
      });
    }
  });

  it("leaves a failed write unseen", async () => {
    const broken = createFileBackedVfs({
      ...makeMemorySecretFiles(),
      write: (path) =>
        Effect.fail(new SecretFsUnavailable({ path, reason: "down" })),
    });
    await expect(
      broken.seams.writeRaw("tomb/t/header", "H"),
    ).rejects.toMatchObject({ _tag: "SecretFsUnavailable" });
    expect(broken.seams.readRaw("tomb/t/header")).toBeNull();
  });

  it("falls back for keys it does not hold, and for deleting keys that could never be here", async () => {
    const seen: string[] = [];
    const vfs = createFileBackedVfs(makeMemorySecretFiles(), {
      readRaw: (key) => (key === "legacy" ? "old" : null),
      deleteRaw: async (key) => {
        seen.push(key);
      },
    });
    expect(vfs.seams.readRaw("legacy")).toBe("old");
    await vfs.seams.deleteRaw("legacy");
    expect(seen).toEqual(["legacy"]);
  });

  it("writes every document again under a new vault key, and the new key alone opens them", async () => {
    const { files, vfs } = await adapter();
    const first = (await mintVaultKey()).vaultKey;
    const second = (await mintVaultKey()).vaultKey;
    const body = withItems(1, "a", "b");
    await vfs.seams.writeRaw(BODY_KEY, await sealed(first, body), first);
    const before = new Map(
      await Promise.all(
        (await run(files.list("t/secrets"))).map(
          async (path) =>
            [path, (await run(files.read(path))).revision] as const,
        ),
      ),
    );
    const rotated: VaultBody = { ...body, rev: 2 };
    await vfs.seams.writeRaw(BODY_KEY, await sealed(second, rotated), second);
    for (const [path, revision] of before) {
      expect((await run(files.read(path))).revision).not.toBe(revision);
    }
    expect(
      await Effect.runPromiseExit(readProjection(files, "t", first)),
    ).toMatchObject({ _tag: "Failure" });
    const reopened = await run(
      readProjection(files, "t", second).pipe(Effect.orDie),
    );
    expect(reopened?.body.items.map((item) => item.name).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("opens the vault that is further on when a flat body and a manifest both exist", async () => {
    const files = makeMemorySecretFiles();
    const { vfs } = await adapter(files);
    const key = (await mintVaultKey()).vaultKey;
    await vfs.seams.writeRaw(
      BODY_KEY,
      await sealed(key, withItems(1, "old")),
      key,
    );
    // A writer with no key leaves a later flat body beside the manifest.
    await vfs.seams.writeRaw(BODY_KEY, await sealed(key, withItems(5, "new")));

    const next = createFileBackedVfs(files);
    await next.hydrate();
    await next.seams.openBody("t", key);
    const body = await openJson<VaultBody>(
      key,
      JSON.parse(next.seams.readRaw(BODY_KEY) ?? ""),
      binding,
    );
    expect(body.items.map((item) => item.name)).toEqual(["new"]);
    // The next keyed write makes it documents and retires the flat file.
    await next.seams.writeRaw(
      BODY_KEY,
      await sealed(key, withItems(6, "new")),
      key,
    );
    expect(await run(files.list("t"))).not.toContain("t/body.json");
    const settled = await run(
      readProjection(files, "t", key).pipe(Effect.orDie),
    );
    expect(settled?.body.items.map((item) => item.name)).toEqual(["new"]);
  });

  it("removes every secret's file, strays included, when the body is deleted", async () => {
    const files = makeMemorySecretFiles();
    const { vfs } = await adapter(files);
    const key = (await mintVaultKey()).vaultKey;
    await vfs.seams.writeRaw(
      BODY_KEY,
      await sealed(key, withItems(1, "a")),
      key,
    );
    await run(files.write("t/secrets/stray.note.json", new Uint8Array([1])));
    await vfs.seams.deleteRaw(BODY_KEY);
    expect(await run(files.list("t"))).toEqual([]);
    expect(vfs.seams.readRaw(BODY_KEY)).toBeNull();
  });

  it("opens nothing for a vault that has no manifest", async () => {
    const { vfs } = await adapter();
    const key = (await mintVaultKey()).vaultKey;
    await vfs.seams.openBody("t", key);
    expect(vfs.seams.readRaw(BODY_KEY)).toBeNull();
  });
});

describe("the VFS's other sealed files as config documents", () => {
  const sealedValue = JSON.stringify({ ivB64: "aXY=", ctB64: "Y3Q=" });

  it("keeps a settings page's file at the address the page shows it under, with its language", async () => {
    const { files, vfs } = await adapter();
    await vfs.seams.writeRaw("tomb/t/config/live-transport", sealedValue);
    await vfs.seams.writeRaw("tomb/t/config/prefs.source.yaml", sealedValue);
    await vfs.seams.writeRaw("tomb/t/config/aws-kms", sealedValue);
    expect(await run(files.list("t"))).toEqual([
      "t/config/aws-kms.json",
      "t/settings/live/transport.json",
      "t/settings/prefs.yaml.json",
    ]);
    const doc = JSON.parse(
      new TextDecoder().decode(
        (await run(files.read("t/settings/prefs.yaml.json"))).bytes,
      ),
    );
    expect(doc).toEqual({
      format: "opensesame.config",
      version: 1,
      path: "config/prefs.source.yaml",
      language: "yaml",
      sealed: { ivB64: "aXY=", ctB64: "Y3Q=" },
    });
  });

  it("gives every config back under its VFS key after a restart, wherever it is filed", async () => {
    const { files, vfs } = await adapter();
    for (const path of [
      "config/live-transport",
      "config/aws-kms",
      "index",
      "config/item-types/marketplaces.json",
    ]) {
      await vfs.seams.writeRaw(`tomb/t/${path}`, sealedValue);
    }
    const next = createFileBackedVfs(files);
    await next.hydrate();
    for (const path of [
      "config/live-transport",
      "config/aws-kms",
      "index",
      "config/item-types/marketplaces.json",
    ]) {
      expect(next.seams.readRaw(`tomb/t/${path}`)).toBe(sealedValue);
    }
    await next.seams.deleteRaw("tomb/t/config/live-transport");
    expect(await run(files.list("t/settings"))).toEqual([
      "t/settings/item-types/marketplaces.json",
    ]);
  });

  it("keeps the header and markers as the plain text they are", async () => {
    const { files, vfs } = await adapter();
    await vfs.seams.writeRaw("tomb/t/header", '{"v":1}');
    await vfs.seams.writeRaw("tomb/t/migrated.v1", "1");
    expect(
      new TextDecoder().decode((await run(files.read("t/header.json"))).bytes),
    ).toBe('{"v":1}');
    expect(
      new TextDecoder().decode(
        (await run(files.read("t/migrated.v1.json"))).bytes,
      ),
    ).toBe("1");
  });

  it("still reads a bare sealed blob from before the envelope, and a stray file in settings is not a vault file", async () => {
    const files = makeMemorySecretFiles([
      ["t/config/old.json", new TextEncoder().encode(sealedValue)],
      ["t/settings/notes.json", new TextEncoder().encode('{"hello":1}')],
    ]);
    const { vfs } = await adapter(files);
    expect(vfs.seams.readRaw("tomb/t/config/old")).toBe(sealedValue);
    expect(vfs.seams.readRaw("tomb/t/settings/notes")).toBeNull();
    await expect(
      vfs.seams.writeRaw("tomb/t/settings/notes", sealedValue),
    ).rejects.toMatchObject({ _tag: "SecretFsRejected" });
  });
});
