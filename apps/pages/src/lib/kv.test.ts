import { afterEach, describe, expect, it, vi } from "vitest";
import {
  kvDelete,
  kvDeleteDurable,
  kvDurability,
  kvGet,
  kvHydrate,
  kvSet,
  kvSetDurable,
} from "./kv.js";

type FakeRoot = ReturnType<typeof makeOpfsRoot>;
type FakeOpfsOptions = { failWrites?: boolean };

function makeOpfsRoot(options: FakeOpfsOptions = {}) {
  const files = new Map<string, string>();
  return {
    files,
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!opts?.create) {
          throw new DOMException("not found", "NotFoundError");
        }
        files.set(name, "");
      }
      return {
        async getFile() {
          return {
            async text() {
              return files.get(name) ?? "";
            },
          };
        },
        async createWritable() {
          return {
            async write(value: string) {
              if (options.failWrites) throw new Error("disk full");
              files.set(name, value);
            },
            async close() {},
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.has(name)) {
        throw new DOMException("not found", "NotFoundError");
      }
      files.delete(name);
    },
  };
}

function stubOpfs(root: FakeRoot | null) {
  vi.stubGlobal("navigator", {
    storage: root ? { getDirectory: () => Promise.resolve(root) } : undefined,
  });
}

async function flush(): Promise<void> {
  // Let the fire-and-forget OPFS writes inside kvSet/kvDelete settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("kv with OPFS backing", () => {
  it("persists writes into OPFS under sanitized file names", async () => {
    const root = makeOpfsRoot();
    stubOpfs(root);

    kvSet("settings.v1", "payload");
    await flush();

    expect(kvDurability()).toBe("persistent");
    expect(root.files.get("opensesame-pages-settings.v1.json")).toBe("payload");

    kvSet("odd key/with:chars", "x");
    await flush();
    expect(root.files.get("opensesame-pages-odd_key_with_chars.json")).toBe(
      "x",
    );
  });

  it("hydrates memory from OPFS and reports durability", async () => {
    const root = makeOpfsRoot();
    root.files.set("opensesame-pages-a.json", "1");
    stubOpfs(root);

    await kvHydrate(["a", "missing"]);

    expect(kvGet("a")).toBe("1");
    expect(kvGet("missing")).toBeNull();
    expect(kvDurability()).toBe("persistent");
  });

  it("settles memory durability when OPFS is absent or throws", async () => {
    stubOpfs(null);
    await kvHydrate([]);
    expect(kvDurability()).toBe("memory");

    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: () => Promise.reject(new Error("no OPFS")),
      },
    });
    await kvHydrate([]);
    expect(kvDurability()).toBe("memory");
  });

  it("keeps memory authoritative when a background OPFS write fails", async () => {
    const root = makeOpfsRoot({ failWrites: true });
    stubOpfs(root);

    kvSet("k", "in-memory");
    await flush();

    expect(kvGet("k")).toBe("in-memory");
  });

  it("rolls a durable write back when OPFS refuses it", async () => {
    const root = makeOpfsRoot();
    stubOpfs(root);
    await kvSetDurable("k", "before");

    const failing = makeOpfsRoot({ failWrites: true });
    failing.files.set("opensesame-pages-k.json", "before");
    stubOpfs(failing);

    await expect(kvSetDurable("k", "after")).rejects.toThrow(/disk full/);
    expect(kvGet("k")).toBe("before");

    await expect(kvSetDurable("fresh", "value")).rejects.toThrow(/disk full/);
    expect(kvGet("fresh")).toBeNull();
  });

  it("resolves durable writes when OPFS is absent", async () => {
    stubOpfs(null);
    await expect(kvSetDurable("k", "v")).resolves.toBeUndefined();
    expect(kvGet("k")).toBe("v");
  });

  it("deletes from OPFS in the background and durably", async () => {
    const root = makeOpfsRoot();
    stubOpfs(root);
    await kvSetDurable("k", "v");
    expect(root.files.has("opensesame-pages-k.json")).toBe(true);

    kvDelete("k");
    await flush();
    expect(root.files.has("opensesame-pages-k.json")).toBe(false);
    expect(kvGet("k")).toBeNull();

    await kvSetDurable("k", "v");
    await kvDeleteDurable("k");
    expect(root.files.has("opensesame-pages-k.json")).toBe(false);
    expect(kvGet("k")).toBeNull();
  });

  it("treats deleting an absent key as success but surfaces other failures", async () => {
    const root = makeOpfsRoot();
    stubOpfs(root);
    await expect(kvDeleteDurable("never-there")).resolves.toBeUndefined();

    const broken = {
      ...makeOpfsRoot(),
      async removeEntry() {
        throw new DOMException("locked", "InvalidStateError");
      },
    };
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(broken) },
    });
    await expect(kvDeleteDurable("k")).rejects.toThrow(/locked/);
  });
});
