import { afterEach, describe, expect, it, vi } from "vitest";
import { openOriginFile } from "./at-rest/origin-files.js";
import {
  kvDelete,
  kvDeleteDurable,
  kvDurability,
  kvGet,
  kvHydrate,
  kvRefresh,
  kvSet,
  kvSetDurable,
} from "./kv.js";

type FakeRoot = ReturnType<typeof makeOpfsRoot>;
type FakeOpfsOptions = {
  failWrites?: boolean;
  beforeWrite?: () => Promise<void>;
};
function deferredWrite() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
            size: new TextEncoder().encode(files.get(name) ?? "").length,
            async text() {
              return files.get(name) ?? "";
            },
          };
        },
        async createWritable() {
          let staged = files.get(name) ?? "";
          return {
            async write(value: string) {
              if (options.failWrites) throw new Error("disk full");
              await options.beforeWrite?.();
              staged = value;
            },
            async close() {
              files.set(name, staged);
            },
            async abort() {},
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
  it("aborts a staged authority update when its attempt is cancelled before durable commit", async () => {
    const entered = deferredWrite();
    const resume = deferredWrite();
    let held = false;
    const root = makeOpfsRoot({
      beforeWrite: async () => {
        if (!held) return;
        entered.resolve();
        await resume.promise;
      },
    });
    stubOpfs(root);
    await kvSetDurable("authority", "retained recovery");
    const before = root.files.get("opensesame-pages-authority.json");
    held = true;
    const attempt = new AbortController();
    const pending = kvSetDurable("authority", "active grant", () =>
      attempt.signal.throwIfAborted(),
    );
    const refused = expect(pending).rejects.toThrow();
    await entered.promise;
    attempt.abort();
    resume.resolve();
    await refused;
    expect(root.files.get("opensesame-pages-authority.json")).toBe(before);
    expect(kvGet("authority")).toBe("retained recovery");
  });
  it("refreshes changed records and clears records deleted by another tab", async () => {
    const root = makeOpfsRoot();
    stubOpfs(root);
    await kvSetDurable("authority", "old");
    root.files.set("opensesame-pages-authority.json", "revoked");
    await kvRefresh("authority", 1024);
    expect(kvGet("authority")).toBe("revoked");
    root.files.delete("opensesame-pages-authority.json");
    await kvRefresh("authority", 1024);
    expect(kvGet("authority")).toBeNull();
  });

  it("does not reuse authority after storage access fails", async () => {
    stubOpfs(makeOpfsRoot());
    await kvSetDurable("authority", "old");
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.reject(new Error("unavailable")) },
    });
    await expect(kvRefresh("authority", 1024)).rejects.toThrow("unavailable");
    expect(kvGet("authority")).toBeNull();
  });

  it("does not acknowledge a durable write when OPFS access fails", async () => {
    stubOpfs(makeOpfsRoot());
    await kvSetDurable("authority", "before");
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.reject(new Error("unavailable")) },
    });
    await expect(kvSetDurable("authority", "after")).rejects.toThrow(
      "unavailable",
    );
    expect(kvGet("authority")).toBe("before");
  });

  it("rejects oversized records before reading their text", async () => {
    const root = makeOpfsRoot();
    stubOpfs(root);
    await kvSetDurable("authority", "oversized");
    await expect(kvRefresh("authority", 2)).rejects.toThrow("read limit");
    expect(kvGet("authority")).toBeNull();
    await expect(kvRefresh("authority", Number.NaN)).rejects.toThrow(
      "read limit",
    );
  });

  it("preserves explicitly session-only records without OPFS", async () => {
    stubOpfs(null);
    await kvSetDurable("authority", "session-only");
    await kvRefresh("authority", 1024);
    expect(kvGet("authority")).toBe("session-only");
    expect(kvDurability()).toBe("memory");
  });

  it("persists writes into OPFS under sanitized file names", async () => {
    const root = makeOpfsRoot();
    stubOpfs(root);

    kvSet("settings.v1", "payload");
    await flush();

    expect(kvDurability()).toBe("persistent");
    const file = "opensesame-pages-settings.v1.json";
    const stored = root.files.get(file) ?? "";
    // Sealed at rest (ADR 0149), bound to its file name.
    expect(stored).not.toContain("payload");
    expect(await openOriginFile(file, stored)).toBe("payload");
    expect(await openOriginFile("opensesame-pages-other.json", stored)).toBe(
      null,
    );

    kvSet("odd key/with:chars", "x");
    await flush();
    const odd = "opensesame-pages-odd_key_with_chars.json";
    expect(await openOriginFile(odd, root.files.get(odd) ?? "")).toBe("x");
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
