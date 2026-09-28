import { afterEach, describe, expect, it } from "vitest";
import {
  type StorageLike,
  isSealedForRest,
  openFromRest,
  sealForRest,
  sealedStorage,
  useClientAtRestKeys,
} from "./index.js";

const key = () =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);

function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

afterEach(() => {
  useClientAtRestKeys(() => Promise.reject(new Error("reset")));
});

describe("the seal", () => {
  it("opens only under its key and where it was sealed", async () => {
    const one = key();
    useClientAtRestKeys(() => one);
    const sealed = (await sealForRest("s", "k", "secret")) ?? "";
    expect(isSealedForRest(sealed)).toBe(true);
    expect(sealed).not.toContain("secret");
    expect(await openFromRest("s", "k", sealed)).toBe("secret");
    expect(await openFromRest("s", "other", sealed)).toBeNull();
    expect(await openFromRest("t", "k", sealed)).toBeNull();
    useClientAtRestKeys(key);
    expect(await openFromRest("s", "k", sealed)).toBeNull();
  });

  it("answers null rather than seal under no key", async () => {
    useClientAtRestKeys(() => Promise.reject(new Error("no IndexedDB")));
    expect(await sealForRest("s", "k", "secret")).toBeNull();
  });
});

describe("sealed storage", () => {
  it("writes only seals and reads the plaintext back", async () => {
    const one = key();
    useClientAtRestKeys(() => one);
    const store = memory();
    const view = sealedStorage(store, "sdk");
    await view.set("opensesame:pkce", '{"codeVerifier":"v"}');
    expect(store.getItem("opensesame:pkce")).toMatch(/^osc1\./);
    expect(store.getItem("opensesame:pkce")).not.toContain("codeVerifier");
    // A new page over the same store opens it.
    const next = sealedStorage(store, "sdk");
    expect(await next.get("opensesame:pkce")).toBe('{"codeVerifier":"v"}');
    next.remove("opensesame:pkce");
    expect(store.map.size).toBe(0);
  });

  it("seals a value an older release left in the clear", async () => {
    const one = key();
    useClientAtRestKeys(() => one);
    const store = memory();
    store.setItem("opensesame:session", '{"accessToken":"at"}');
    const view = sealedStorage(store, "sdk");
    expect(await view.get("opensesame:session")).toBe('{"accessToken":"at"}');
    expect(store.getItem("opensesame:session")).toMatch(/^osc1\./);
  });

  it("keeps values in memory, never in the clear, when no key can be kept", async () => {
    useClientAtRestKeys(() => Promise.reject(new Error("no IndexedDB")));
    const store = memory();
    const view = sealedStorage(store, "sdk");
    await view.set("opensesame:session", '{"accessToken":"at"}');
    expect(store.map.size).toBe(0);
    expect(await view.get("opensesame:session")).toBe('{"accessToken":"at"}');
  });
});

describe("sealed storage, in order", () => {
  it("never brings back a value removed while its seal was in flight", async () => {
    const one = key();
    useClientAtRestKeys(() => one);
    const store = memory();
    const view = sealedStorage(store, "sdk");
    const writing = view.set("opensesame:returnTo", "/stale");
    view.remove("opensesame:returnTo");
    await writing;
    expect(store.map.size).toBe(0);
  });

  it("takes a value once: the second taker finds nothing", async () => {
    const one = key();
    useClientAtRestKeys(() => one);
    const store = memory();
    const view = sealedStorage(store, "sdk");
    await view.set("opensesame:pkce", "verifier");
    const [first, second] = await Promise.all([
      view.take("opensesame:pkce"),
      view.take("opensesame:pkce"),
    ]);
    expect([first, second]).toEqual(["verifier", null]);
  });

  it("reports a write superseded before its seal landed", async () => {
    const one = key();
    useClientAtRestKeys(() => one);
    const view = sealedStorage(memory(), "sdk");
    const first = view.set("opensesame:pkce", "one");
    const second = view.set("opensesame:pkce", "two");
    expect(await first).toBe("superseded");
    expect(await second).toBe("stored");
    expect(await view.get("opensesame:pkce")).toBe("two");
  });

  it("never lets a legacy re-seal on read undo a newer write", async () => {
    const one = key();
    useClientAtRestKeys(() => one);
    const store = memory();
    store.setItem("opensesame:session", "old");
    const view = sealedStorage(store, "sdk");
    const reading = view.get("opensesame:session");
    const writing = view.set("opensesame:session", "new");
    expect(await reading).toBe("old");
    expect(await writing).toBe("stored");
    expect(await view.get("opensesame:session")).toBe("new");
  });

  it("says when a value stayed in memory", async () => {
    useClientAtRestKeys(() => Promise.reject(new Error("no IndexedDB")));
    expect(await sealedStorage(memory(), "sdk").set("k", "v")).toBe("memory");
  });
});
