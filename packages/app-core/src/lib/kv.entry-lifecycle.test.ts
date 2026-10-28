import { expect, it } from "vitest";
import { atRestReady } from "./at-rest/key.js";
import { sealOriginFile } from "./at-rest/origin-files.js";
import { deferred, withFixture } from "./kv.entry-lifecycle.test-support.js";
import {
  kvDelete,
  kvDeleteDurable,
  kvFileName,
  kvFlush,
  kvForgetAll,
  kvForgetFiles,
  kvGet,
  kvHydrate,
  kvRefresh,
  kvSet,
  kvSetDurable,
} from "./kv.js";

it("keeps refresh acquisition behind the same physical writer while another entry progresses", () =>
  withFixture(async (root) => {
    const key = "lifecycle/ordered";
    const alias = "lifecycle_ordered";
    expect(kvFileName(alias)).toBe(kvFileName(key));
    await kvSetDurable(key, "before");
    root.events.length = 0;
    const entered = deferred();
    const resume = deferred();
    root.hooks.write = async (name) => {
      if (name === kvFileName(key)) {
        entered.resolve();
        await resume.promise;
      }
    };
    const write = kvSetDurable(key, "after");
    await entered.promise;
    const read = kvRefresh(alias, 1024);
    const independent = kvSetDurable("unrelated", "independent");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const progressed = kvGet("unrelated") === "independent";
    const overlapped = root.events.includes(`file:${kvFileName(key)}`);
    resume.resolve();
    await Promise.all([write, read, independent]);
    expect(progressed).toBe(true);
    expect(overlapped).toBe(false);
    expect(kvGet(alias)).toBe("after");
    expect(root.events.indexOf(`close:${kvFileName(key)}`)).toBeLessThan(
      root.events.indexOf(`file:${kvFileName(key)}`),
    );
  }));

it("keeps the entire snapshot text read ahead of the next writer and durable cache publication", () =>
  withFixture(async (root) => {
    const key = "lifecycle/read-first";
    await kvSetDurable(key, "before");
    root.events.length = 0;
    const entered = deferred();
    const resume = deferred();
    root.hooks.read = async (name) => {
      if (name === kvFileName(key)) {
        entered.resolve();
        await resume.promise;
      }
    };
    const read = kvRefresh(key, 1024);
    await entered.promise;
    const write = kvSetDurable(key, "after");
    const independent = kvSetDurable("unrelated", "independent");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const progressed = kvGet("unrelated") === "independent";
    const overlapped = root.events.includes(`writer:${kvFileName(key)}`);
    resume.resolve();
    await Promise.all([read, write, independent]);
    expect(progressed).toBe(true);
    expect(overlapped).toBe(false);
    expect(kvGet(key)).toBe("after");
    expect(root.events.indexOf(`read-end:${kvFileName(key)}`)).toBeLessThan(
      root.events.indexOf(`writer:${kvFileName(key)}`),
    );
  }));

it("does not let an older hydrate replace a newer immediate session value", () =>
  withFixture(async (root) => {
    const key = "lifecycle/hydrate";
    await kvSetDurable(key, "before");
    kvForgetAll();
    const entered = deferred();
    const resume = deferred();
    root.hooks.read = async () => {
      entered.resolve();
      await resume.promise;
    };
    const hydrate = kvHydrate([key]);
    await entered.promise;
    kvSet(key, "new session value");
    const immediate = kvGet(key);
    resume.resolve();
    await hydrate;
    expect(immediate).toBe("new session value");
    await kvFlush();
    expect(kvGet(key)).toBe("new session value");
  }));

it("does not let an older durable completion replace a newer immediate session value", () =>
  withFixture(async (root) => {
    const key = "lifecycle/durable";
    await kvSetDurable(key, "before");
    const entered = deferred();
    const resume = deferred();
    root.hooks.write = async (name) => {
      if (name === kvFileName(key)) {
        entered.resolve();
        await resume.promise;
      }
    };
    const durable = kvSetDurable(key, "earlier durable value");
    await entered.promise;
    kvSet(key, "new session value");
    resume.resolve();
    await durable;
    expect(kvGet(key)).toBe("new session value");
    await kvFlush();
  }));

it("retains prior cache on a cancelled durable turn and permits the following ordinary read/write", () =>
  withFixture(async (root) => {
    const key = "lifecycle/cancel";
    await kvSetDurable(key, "retained");
    const entered = deferred();
    const resume = deferred();
    root.hooks.write = async () => {
      entered.resolve();
      await resume.promise;
    };
    const cancelled = new Error("owned commit cancelled");
    const write = kvSetDurable(key, "not committed", () => {
      throw cancelled;
    });
    const refused = expect(write).rejects.toBe(cancelled);
    await entered.promise;
    const read = kvHydrate([key]);
    resume.resolve();
    await refused;
    expect(kvGet(key)).toBe("retained");
    await read;
    expect(kvGet(key)).toBe("retained");
    await kvSetDurable(key, "following commit");
    expect(kvGet(key)).toBe("following commit");
  }));

it.each(["all", "files"])(
  "keeps a pending hydrate from resurrecting memory forgotten by %s",
  (mode) =>
    withFixture(async (root) => {
      const key = "lifecycle/forget";
      await kvSetDurable(key, "retained");
      const entered = deferred();
      const resume = deferred();
      root.hooks.read = async () => {
        entered.resolve();
        await resume.promise;
      };
      const read = kvHydrate([key]);
      await entered.promise;
      if (mode === "all") kvForgetAll();
      else kvForgetFiles(new Set([kvFileName(key)]));
      resume.resolve();
      await read;
      expect(kvGet(key)).toBeNull();
    }),
);

it("refuses a refreshed snapshot superseded by immediate memory mutation", () =>
  withFixture(async (root) => {
    const key = "lifecycle/refresh-generation";
    await kvSetDurable(key, "before");
    const entered = deferred();
    const resume = deferred();
    root.hooks.read = async () => {
      entered.resolve();
      await resume.promise;
    };
    const refresh = kvRefresh(key, 1024);
    const refused = expect(refresh).rejects.toThrow(
      "Storage changed during refresh",
    );
    await entered.promise;
    kvSet(key, "new session value");
    resume.resolve();
    await refused;
    expect(kvGet(key)).toBeNull();
    await kvFlush();
    await kvRefresh(key, 1024);
    expect(kvGet(key)).toBe("new session value");
  }));

it("rechecks the original authority on entry after waiting for a writer", () =>
  withFixture(async (root) => {
    const key = "lifecycle/original";
    await kvSetDurable(key, "before");
    const entered = deferred();
    const resume = deferred();
    root.hooks.write = async () => {
      entered.resolve();
      await resume.promise;
    };
    const write = kvSetDurable(key, "after");
    await entered.promise;
    let current = true;
    const changed = new Error("original owner changed");
    const read = kvRefresh(key, 1024, () => {
      if (!current) throw changed;
    });
    const refused = expect(read).rejects.toBe(changed);
    current = false;
    resume.resolve();
    await write;
    await refused;
    expect(kvGet(key)).toBeNull();
  }));

it("finishes authenticated unreadability before a following writer can overwrite the file", () =>
  withFixture(async (root) => {
    const key = "lifecycle/foreign";
    const name = kvFileName(key);
    const foreign = sealOriginFile(
      await atRestReady(),
      "another-file.json",
      "foreign sealed record",
    );
    root.files.set(name, foreign);
    const entered = deferred();
    const resume = deferred();
    root.hooks.read = async () => {
      entered.resolve();
      await resume.promise;
    };
    const read = kvHydrate([key]);
    await entered.promise;
    const write = kvSetDurable(key, "must not overwrite");
    const refused = expect(write).rejects.toThrow("refusing to overwrite");
    resume.resolve();
    await read;
    await refused;
    expect(root.files.get(name)).toBe(foreign);
    expect(kvGet(key)).toBeNull();
  }));

it("does not restore an old unreadable marker after reset forgets the pending read", () =>
  withFixture(async (root) => {
    const key = "lifecycle/reset-unreadable";
    const name = kvFileName(key);
    root.files.set(
      name,
      sealOriginFile(
        await atRestReady(),
        "another-file.json",
        "old sealed record",
      ),
    );
    const entered = deferred();
    const resume = deferred();
    root.hooks.read = async () => {
      entered.resolve();
      await resume.promise;
    };
    const read = kvHydrate([key]);
    await entered.promise;
    kvForgetAll();
    resume.resolve();
    await read;
    root.files.delete(name);
    await kvSetDurable(key, "new origin value");
    expect(kvGet(key)).toBe("new origin value");
  }));

it("reserves a hydrate publication before its initial durability probe awaits", () =>
  withFixture(async (root) => {
    const key = "lifecycle/forget-probe";
    await kvSetDurable(key, "retained");
    const entered = deferred();
    const resume = deferred();
    let held = false;
    root.hooks.root = async () => {
      if (held) return;
      held = true;
      entered.resolve();
      await resume.promise;
    };
    const read = kvHydrate([key]);
    await entered.promise;
    kvForgetAll();
    resume.resolve();
    await read;
    expect(kvGet(key)).toBeNull();
  }));

it("refuses stale authoritative absence after a newer immediate session mutation", () =>
  withFixture(async (root) => {
    const key = "lifecycle/missing-generation";
    const entered = deferred();
    const resume = deferred();
    let held = false;
    root.hooks.lookup = async (name) => {
      if (held || name !== kvFileName(key)) return;
      held = true;
      entered.resolve();
      await resume.promise;
    };
    const refresh = kvRefresh(key, 1024);
    const refused = expect(refresh).rejects.toThrow(
      "Storage changed during refresh",
    );
    await entered.promise;
    kvSet(key, "new session value");
    resume.resolve();
    await refused;
    expect(kvGet(key)).toBeNull();
    await kvFlush();
    await kvRefresh(key, 1024);
    expect(kvGet(key)).toBe("new session value");
  }));

it.each(["sync", "durable"])(
  "orders %s removal after an active snapshot and keeps immediate cache deletion",
  (mode) =>
    withFixture(async (root) => {
      const key = "lifecycle/remove";
      await kvSetDurable(key, "before");
      root.events.length = 0;
      const entered = deferred();
      const resume = deferred();
      root.hooks.read = async () => {
        entered.resolve();
        await resume.promise;
      };
      const read = kvHydrate([key]);
      await entered.promise;
      let removal: Promise<void>;
      if (mode === "sync") {
        kvDelete(key);
        removal = kvFlush();
      } else removal = kvDeleteDurable(key);
      const immediate = kvGet(key);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const overlapped = root.events.includes(`remove:${kvFileName(key)}`);
      resume.resolve();
      await Promise.all([read, removal]);
      expect(immediate).toBeNull();
      expect(overlapped).toBe(false);
      expect(kvGet(key)).toBeNull();
      expect(root.files.has(kvFileName(key))).toBe(false);
    }),
);
