import { expect, it } from "vitest";
/**
 * A vault directory that has been tampered with (ADR 0182): a secret's file
 * deleted, put back at an older revision, swapped for another's, renamed by
 * hand or carried in from another vault, and a stray file nobody listed. The
 * vault must refuse each, or ignore it, and never open it.
 */
import { VaultCorruptError, VaultStore } from "../vault/store.js";
import type { FilesHarness } from "./files.conformance.js";
import {
  type InProcess,
  PASSWORD,
  run,
  secret,
  startProcess,
} from "./vault-on-files.support.js";

export function tamperCases(
  inProcess: InProcess,
  make: () => Promise<FilesHarness>,
): void {
  it("refuses to open a vault whose secret file has gone", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItems([secret("a"), secret("b")]);
      await run(files.remove("personal/secrets/a.secret.json"));
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
    }));

  it("refuses a secret file put back to an older revision", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      const item = secret("a", "v1");
      await store.saveItem(item);
      const old = (await run(files.read("personal/secrets/a.secret.json")))
        .bytes;
      await store.saveItem({ ...item, value: "v2" });
      await run(files.write("personal/secrets/a.secret.json", old));
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
    }));

  it("refuses two secrets' files swapped, and a file renamed by hand", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItems([secret("a", "1"), secret("b", "2")]);
      const a = (await run(files.read("personal/secrets/a.secret.json"))).bytes;
      const b = (await run(files.read("personal/secrets/b.secret.json"))).bytes;
      await run(files.write("personal/secrets/a.secret.json", b));
      await run(files.write("personal/secrets/b.secret.json", a));
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
      await run(files.write("personal/secrets/a.secret.json", a));
      await run(files.write("personal/secrets/b.secret.json", b));
      await run(files.write("personal/secrets/moved.secret.json", a));
      await run(files.remove("personal/secrets/a.secret.json"));
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
    }));

  it("ignores a file nobody listed, rather than trusting it", () =>
    inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItem(secret("a"));
      const a = (await run(files.read("personal/secrets/a.secret.json"))).bytes;
      await run(files.write("personal/secrets/stray.secret.json", a));
      const reopened = await restart();
      expect(reopened.getSnapshot().items).toHaveLength(1);
    }));

  it("refuses a secret file from another vault", async () => {
    const foreign = await make();
    const stopForeign = await startProcess(foreign.files);
    let theirs: Uint8Array;
    try {
      const other = new VaultStore();
      await other.create(PASSWORD);
      await other.saveItem(secret("a", "theirs"));
      theirs = (await run(foreign.files.read("personal/secrets/a.secret.json")))
        .bytes;
    } finally {
      stopForeign();
      await foreign.cleanup?.();
    }
    await inProcess(async (files, restart) => {
      const store = new VaultStore();
      await store.create(PASSWORD);
      await store.saveItem(secret("a", "mine"));
      await run(files.write("personal/secrets/a.secret.json", theirs));
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
    });
  });
}
