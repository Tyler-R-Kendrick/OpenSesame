import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileStorage } from "./file-storage.js";
import { createNodeHost } from "./host.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-core-file-storage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createFileStorage", () => {
  it("persists across instances", () => {
    const path = join(dir, "nested", "local-storage.json");
    const first = createFileStorage(path);
    first.setItem("opensesame.a", "1");
    first.setItem("opensesame.b", "2");
    first.removeItem("opensesame.a");
    const second = createFileStorage(path);
    expect(second.getItem("opensesame.a")).toBeNull();
    expect(second.getItem("opensesame.b")).toBe("2");
    expect(second.length).toBe(1);
  });

  it("keeps separately constructed Hosts current without losing other keys", () => {
    const first = createNodeHost({ stateDir: dir }).storage?.local;
    const second = createNodeHost({ stateDir: dir }).storage?.local;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    first?.setItem("owner-remote", "remote-a");
    second?.setItem("another-key", "retained");
    expect(first?.getItem("another-key")).toBe("retained");
    expect(second?.getItem("owner-remote")).toBe("remote-a");
    expect(first?.length).toBe(2);
    expect(second?.key(0)).toBe("owner-remote");
    second?.removeItem("owner-remote");
    first?.setItem("new-key", "fresh");
    expect(second?.getItem("owner-remote")).toBeNull();
    expect(
      JSON.parse(readFileSync(join(dir, "local-storage.json"), "utf8")),
    ).toEqual({
      "another-key": "retained",
      "new-key": "fresh",
    });
  });

  it("refreshes a stale parent after a separate process publishes disk changes", () => {
    const path = join(dir, "local-storage.json");
    const store = createFileStorage(path);
    store.setItem("remove-me", "initial");
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFileSync, writeFileSync, renameSync } from "node:fs";
       const path = process.argv[1];
       const entries = JSON.parse(readFileSync(path, "utf8"));
       entries["external-owner-metadata"] = "external";
       const pending = path + ".external.tmp";
       writeFileSync(pending, JSON.stringify(entries), { mode: 0o600 });
       renameSync(pending, path);`,
        path,
      ],
      { timeout: 10_000 },
    );
    expect(store.getItem("external-owner-metadata")).toBe("external");
    store.removeItem("remove-me");
    store.setItem("parent-key", "new");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "external-owner-metadata": "external",
      "parent-key": "new",
    });
  });

  it("propagates unreadable paths before creating or replacing storage", () => {
    const store = createFileStorage(join(dir, "state.json"));
    mkdirSync(join(dir, "state.json"));
    for (const action of [
      () => store.getItem("k"),
      () => store.length,
      () => store.key(0),
      () => store.setItem("k", "v"),
      () => store.removeItem("k"),
    ]) {
      expect(action).toThrow();
      expect(statSync(join(dir, "state.json")).isDirectory()).toBe(true);
    }
    writeFileSync(join(dir, "file-parent"), "preserved");
    expect(() =>
      createFileStorage(join(dir, "file-parent", "state.json")),
    ).toThrow();
    expect(readFileSync(join(dir, "file-parent"), "utf8")).toBe("preserved");
  });

  it("refuses malformed changed disk state without replacing its bytes", () => {
    const path = join(dir, "local-storage.json");
    const store = createFileStorage(path);
    store.setItem("existing", "valid");
    const corrupt = "{malformed";
    writeFileSync(path, corrupt);
    for (const action of [
      () => store.getItem("existing"),
      () => store.length,
      () => store.key(0),
      () => store.setItem("k", "v"),
      () => store.removeItem("existing"),
    ]) {
      expect(action).toThrow();
      expect(readFileSync(path, "utf8")).toBe(corrupt);
    }
  });

  it.skipIf(process.platform === "win32")(
    "writes owner-only files in an owner-only directory",
    () => {
      const path = join(dir, "state", "local-storage.json");
      createFileStorage(path).setItem("k", "v");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    },
  );

  it("leaves no temporary file behind", () => {
    const path = join(dir, "local-storage.json");
    createFileStorage(path).setItem("k", "v");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ k: "v" });
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });

  it("ignores non-string entries a hand-edited file may hold", () => {
    const path = join(dir, "local-storage.json");
    writeFileSync(path, JSON.stringify({ ok: "1", bad: 2 }));
    const store = createFileStorage(path);
    expect(store.getItem("ok")).toBe("1");
    expect(store.getItem("bad")).toBeNull();
  });
});

describe("createNodeHost", () => {
  it("stores under the state directory and has no page", () => {
    const host = createNodeHost({ stateDir: dir });
    host.storage?.local?.setItem("k", "v");
    expect(readFileSync(join(dir, "local-storage.json"), "utf8")).toContain(
      '"k":"v"',
    );
    expect(host.page).toBeUndefined();
    expect(host.worker).toBeUndefined();
    expect(host.environment?.online).toBe(true);
  });
});
