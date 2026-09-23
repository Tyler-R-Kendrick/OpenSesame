import {
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
