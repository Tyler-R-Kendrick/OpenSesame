/**
 * The vault on a secret file store (ADR 0182): what a person sees in the
 * directory, and what a store must do when the directory is edited, restored
 * or raced. Run against the emulation and against a real disk — a difference
 * between them is a bug in one. Tampering is `vault-on-files-tamper.conformance.ts`.
 */
import { createItem } from "@opensesame/vault-core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { VaultStore } from "../vault/store.js";
import { BODY_PATH, PERSONAL_TOMB, tombFileKey, vfsSeams } from "../vfs.js";
import { SecretFsUnavailable } from "./errors.js";
import type { FilesHarness } from "./files.conformance.js";
import type { SecretFiles } from "./files.js";
import { tamperCases } from "./vault-on-files-tamper.conformance.js";
import {
  type InProcess,
  MARKER,
  PASSWORD,
  bytes,
  heldValue,
  processOver,
  run,
  secret,
  text,
  tree,
} from "./vault-on-files.support.js";

function layoutCases(inProcess: InProcess): void {
  it("keeps each secret in a file of its own, named for it and its folder", () =>
    inProcess(async (files) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      const folder = await store.addFolder("work/aws");
      await store.saveItem(secret("Prod Deploy", MARKER, folder.id), folder);
      await store.saveItem(secret("wifi"));
      await store.saveItem(createItem("note", "Read me"));
      const paths = await run(files.list(""));
      expect(paths).toEqual(
        expect.arrayContaining([
          "personal/header.json",
          "personal/vault.json",
          "personal/secrets/work/aws/Prod-Deploy.secret.json",
          "personal/secrets/wifi.secret.json",
          "personal/secrets/Read-me.note.json",
        ]),
      );
      expect(paths).not.toContain("personal/body.json");
      // The vault's settings are documents too, not opaque blobs.
      const prefs = JSON.parse(
        text((await run(files.read("personal/index.json"))).bytes),
      );
      expect(prefs).toMatchObject({
        format: "opensesame.config",
        path: "index",
        language: "json",
      });
      const doc = JSON.parse(
        text(
          (await run(files.read("personal/secrets/wifi.secret.json"))).bytes,
        ),
      );
      expect(doc).toMatchObject({
        format: "opensesame.secret",
        version: 1,
        kind: "secret",
      });
      expect(Object.keys(doc.sealed).sort()).toEqual(["ctB64", "ivB64"]);
    }));

  it("keeps no secret value in the clear anywhere in the directory", () =>
    inProcess(async (files) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItem(secret("wifi"));
      for (const path of await run(files.list(""))) {
        const content = text((await run(files.read(path))).bytes);
        expect(content).not.toContain(MARKER);
        expect(content).not.toContain(PASSWORD);
      }
    }));

  it("opens again in a new process with every secret as it was", () =>
    inProcess(async (_files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      const folder = await store.addFolder("home");
      await store.saveItem(secret("wifi", "pw-1", folder.id), folder);
      await store.saveItem(secret("alarm", "pw-2"));
      const reopened = await restart();
      const items = reopened.getSnapshot().items;
      expect(items.map((item) => item.name).sort()).toEqual(["alarm", "wifi"]);
      expect(items.find((item) => item.name === "wifi")).toMatchObject({
        value: "pw-1",
        folderId: folder.id,
      });
    }));
}

function editCases(inProcess: InProcess): void {
  it("rewrites only the secret that changed, and the manifest, in the process that made it and the next", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItems([secret("one", "1"), secret("two", "2")]);
      const touched = async (edit: VaultStore) => {
        const before = await tree(files);
        const two = edit.getSnapshot().items.find((it) => it.name === "two");
        if (two?.kind !== "secret") throw new Error("two is a secret");
        await edit.saveItem({ ...two, value: `${two.value}+` });
        const after = await tree(files);
        return [...after]
          .filter(([path, rev]) => before.get(path) !== rev)
          .map(([path]) => path);
      };
      const first = await touched(store);
      const second = await touched(await restart());
      for (const changed of [first, second]) {
        expect(changed).toContain("personal/secrets/two.secret.json");
        expect(changed).toContain("personal/vault.json");
        expect(changed).not.toContain("personal/secrets/one.secret.json");
      }
    }));

  it("moves a secret's file when it is renamed, and removes it when it is purged", () =>
    inProcess(async (files) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      const item = secret("old name");
      await store.saveItem(item);
      await store.saveItem({ ...item, name: "new name" });
      let paths = await run(files.list("personal/secrets"));
      expect(paths).toEqual(["personal/secrets/new-name.secret.json"]);
      await store.trashItem(item.id);
      await store.purgeItem(item.id);
      paths = await run(files.list("personal/secrets"));
      expect(paths).toEqual([]);
    }));

  it("keeps two secrets of one name in two files", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItems([secret("same", "a"), secret("same", "b")]);
      expect(await run(files.list("personal/secrets"))).toHaveLength(2);
      const reopened = await restart();
      expect(
        reopened
          .getSnapshot()
          .items.map((item) => heldValue(item))
          .sort(),
      ).toEqual(["a", "b"]);
    }));
}

function raceAndFailureCases(inProcess: InProcess): void {
  it("fails a save that lost a race, and keeps the winner's secrets", () =>
    inProcess(async (files) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItem(secret("a", "mine"));
      const manifest = (await run(files.read("personal/vault.json"))).bytes;
      // Another writer moves the vault on.
      await run(
        files.write("personal/vault.json", new Uint8Array([...manifest, 10])),
      );
      const rival = (await run(files.read("personal/secrets/a.secret.json")))
        .bytes;
      await expect(store.saveItem(secret("b", "late"))).rejects.toMatchObject({
        _tag: "SecretFsConflict",
      });
      expect(store.getSnapshot().items.map((item) => item.name)).toEqual(["a"]);
      expect(
        text((await run(files.read("personal/secrets/a.secret.json"))).bytes),
      ).toBe(text(rival));
      expect(await run(files.list("personal/secrets"))).toEqual([
        "personal/secrets/a.secret.json",
      ]);
    }));

  it("settles a save that died before its manifest on the next save", () => {
    const outage = { on: false };
    const flaky = (files: SecretFiles): SecretFiles => ({
      ...files,
      write: (path, data, options) =>
        outage.on && path.endsWith("/vault.json")
          ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
          : files.write(path, data, options),
    });
    return inProcess(async (_files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      const item = secret("a", "v1");
      await store.saveItem(item);
      outage.on = true;
      await expect(
        store.saveItem({ ...item, value: "v2" }),
      ).rejects.toMatchObject({
        _tag: "SecretFsUnavailable",
      });
      outage.on = false;
      expect(heldValue(store.getSnapshot().items[0])).toBe("v1");
      await store.saveItem(secret("b", "v1"));
      const reopened = await restart();
      const values = Object.fromEntries(
        reopened.getSnapshot().items.map((it) => [it.name, heldValue(it)]),
      );
      expect(values).toEqual({ a: "v1", b: "v1" });
    }, flaky);
  });
}

function lifecycleCases(inProcess: InProcess): void {
  it("moves a flat vault from before this layout onto files at its next save", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItem(secret("a", "kept"));
      // Rebuild what an older process left: one flat body and no documents.
      const flat =
        vfsSeams.readRaw(tombFileKey(PERSONAL_TOMB, BODY_PATH)) ?? "";
      expect(flat).not.toBe("");
      for (const path of await run(files.list("personal/secrets")))
        await run(files.remove(path));
      await run(files.remove("personal/vault.json"));
      await run(files.write("personal/body.json", bytes(flat)));
      const reopened = await restart();
      expect(reopened.getSnapshot().items.map((item) => item.name)).toEqual([
        "a",
      ]);
      await reopened.saveItem(secret("b", "new"));
      expect(await run(files.list("personal"))).not.toContain(
        "personal/body.json",
      );
      const again = await restart();
      expect(
        again
          .getSnapshot()
          .items.map((item) => item.name)
          .sort(),
      ).toEqual(["a", "b"]);
    }));

  it("removes every secret's file when the vault is destroyed", () =>
    inProcess(async (files) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItems([secret("a"), secret("b")]);
      await store.destroy();
      const left = await run(files.list(""));
      expect(
        left.filter(
          (path) =>
            path.includes("/secrets/") ||
            path.endsWith("vault.json") ||
            path.endsWith("body.json"),
        ),
      ).toEqual([]);
    }));
}

function folderCases(inProcess: InProcess): void {
  it("makes a folder a directory, empty or not, and brings it back", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      const empty = await store.addFolder("clients/acme");
      const full = await store.addFolder("home");
      await store.saveItem(secret("wifi", "pw", full.id), full);
      const paths = await run(files.list("personal/secrets"));
      expect(paths).toContain("personal/secrets/clients/acme/folder.dir.json");
      expect(paths).toContain("personal/secrets/home/folder.dir.json");
      expect(paths).toContain("personal/secrets/home/wifi.secret.json");
      const reopened = await restart();
      const folders = reopened.getSnapshot().folders;
      expect(folders.map((folder) => folder.name).sort()).toEqual([
        "clients/acme",
        "home",
      ]);
      expect(folders.find((folder) => folder.id === empty.id)).toBeDefined();
    }));

  it("moves a folder's directory and its secrets when it is renamed, and removes it when deleted", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      const folder = await store.addFolder("old");
      await store.saveItem(secret("wifi", "pw", folder.id), folder);
      await store.renameFolder(folder.id, "new");
      expect(await run(files.list("personal/secrets"))).toEqual([
        "personal/secrets/new/folder.dir.json",
        "personal/secrets/new/wifi.secret.json",
      ]);
      const reopened = await restart();
      expect(reopened.getSnapshot().items[0]?.folderId).toBe(folder.id);
      await reopened.deleteFolder(folder.id);
      const left = await run(files.list("personal/secrets"));
      expect(left.filter((path) => path.endsWith("folder.dir.json"))).toEqual(
        [],
      );
    }));

  it("keeps two folders that spell one directory in two marker files", () =>
    inProcess(async (files) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.addFolder("Work Stuff");
      await store.addFolder("Work-Stuff");
      const markers = (await run(files.list("personal/secrets"))).filter(
        (path) => path.includes("folder"),
      );
      expect(markers).toHaveLength(2);
    }));
}

export function describeVaultOnFiles(
  name: string,
  make: () => Promise<FilesHarness>,
): void {
  describe(`the vault on ${name}`, () => {
    const inProcess = processOver(make);
    layoutCases(inProcess);
    editCases(inProcess);
    folderCases(inProcess);
    tamperCases(inProcess, make);
    raceAndFailureCases(inProcess);
    lifecycleCases(inProcess);
  });
}
