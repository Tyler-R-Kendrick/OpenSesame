/**
 * Nothing the app stores rests in the clear (ADR 0148): the seal, the key's
 * three states, and each store the app writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createMemoryStorage } from "../../memory-storage.js";
import {
  type AtRestKeyPort,
  type WebStorage,
  localStore,
  sessionStore,
} from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import {
  AT_REST_PREFIX,
  atRestBinding,
  isSealedAtRest,
  openAtRest,
  sealAtRest,
} from "./cipher.js";
import {
  atRestKeyNow,
  atRestReady,
  atRestSettled,
  forgetAtRestKeyForTest,
} from "./key.js";
import {
  AtRestKeyPendingError,
  forgetHeldWebStorageForTest,
  sealLegacyWebStorage,
} from "./web-storage.js";

const KEY = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);

function deferredKeys(): AtRestKeyPort & {
  resolve(key: Uint8Array): void;
  reject(): void;
} {
  let resolve: (key: Uint8Array) => void = () => {};
  let reject: () => void = () => {};
  const loaded = new Promise<Uint8Array>((ok, fail) => {
    resolve = ok;
    reject = () => fail(new Error("no key"));
  });
  return { load: () => loaded, resolve, reject };
}

let local: WebStorage;
let session: WebStorage;

function install(atRestKeys: AtRestKeyPort | undefined): void {
  forgetAtRestKeyForTest();
  forgetHeldWebStorageForTest();
  local = createMemoryStorage();
  session = createMemoryStorage();
  configureHost(createTestHost({ storage: { local, session }, atRestKeys }));
}

beforeEach(() => install({ loadSync: () => KEY, load: async () => KEY }));

afterEach(() => {
  forgetAtRestKeyForTest();
  forgetHeldWebStorageForTest();
  configureHost(createTestHost());
});

describe("the seal", () => {
  const where = atRestBinding("web-storage.local", "opensesame.settings");

  it("opens only under its key and where it was sealed", () => {
    const sealed = sealAtRest(KEY, where, '{"theme":"dark"}');
    expect(sealed.startsWith(AT_REST_PREFIX)).toBe(true);
    expect(sealed).not.toContain("dark");
    expect(openAtRest(KEY, where, sealed)).toBe('{"theme":"dark"}');
    expect(openAtRest(OTHER, where, sealed)).toBeNull();
    const elsewhere = atRestBinding("web-storage.local", "opensesame.other");
    expect(openAtRest(KEY, elsewhere, sealed)).toBeNull();
  });

  it("is fresh every time and refuses a tampered or truncated value", () => {
    const one = sealAtRest(KEY, where, "x");
    expect(sealAtRest(KEY, where, "x")).not.toBe(one);
    const flipped = `${one.slice(0, -2)}${one.endsWith("A") ? "B" : "A"}${one.slice(-1)}`;
    expect(openAtRest(KEY, where, flipped)).toBeNull();
    expect(openAtRest(KEY, where, AT_REST_PREFIX)).toBeNull();
    expect(openAtRest(KEY, where, `${AT_REST_PREFIX}!!`)).toBeNull();
    expect(openAtRest(KEY, where, "plain")).toBeNull();
  });
});

describe("Web Storage through the ports", () => {
  it("stores every value sealed and reads it back in the clear", () => {
    localStore().setItem("opensesame.settings", '{"hostApi":"https://h"}');
    sessionStore().setItem("opensesame.claim", "osc_clm_a.secret");

    const rawLocal = local.getItem("opensesame.settings") ?? "";
    const rawSession = session.getItem("opensesame.claim") ?? "";
    expect(isSealedAtRest(rawLocal)).toBe(true);
    expect(rawLocal).not.toContain("hostApi");
    expect(rawSession).not.toContain("secret");
    expect(localStore().getItem("opensesame.settings")).toBe(
      '{"hostApi":"https://h"}',
    );
    expect(sessionStore().getItem("opensesame.claim")).toBe("osc_clm_a.secret");
  });

  it("binds a value to its area and key, so a copy does not open", () => {
    localStore().setItem("opensesame.a", "one");
    local.setItem("opensesame.b", local.getItem("opensesame.a") ?? "");
    session.setItem("opensesame.a", local.getItem("opensesame.a") ?? "");
    expect(localStore().getItem("opensesame.b")).toBeNull();
    expect(sessionStore().getItem("opensesame.a")).toBeNull();
  });

  it("reads a value an older build left in the clear, and seals it there", () => {
    local.setItem("opensesame.settings", "legacy");
    expect(localStore().getItem("opensesame.settings")).toBe("legacy");
    expect(isSealedAtRest(local.getItem("opensesame.settings") ?? "")).toBe(
      true,
    );
    expect(localStore().getItem("opensesame.settings")).toBe("legacy");
  });

  it("reads another writer's clear value without sealing it", () => {
    local.setItem("opensesame:session", "a relying party's");
    expect(localStore().getItem("opensesame:session")).toBe(
      "a relying party's",
    );
    expect(local.getItem("opensesame:session")).toBe("a relying party's");
  });

  it("sweeps the app's own clear values and leaves everyone else's", () => {
    local.setItem("opensesame.settings", "ours");
    local.setItem("opensesame:federation:session", "ours too");
    local.setItem("theirs", "not ours");
    local.setItem("opensesame:session", "a relying party's");

    expect(sealLegacyWebStorage("local")).toBe(2);
    expect(local.getItem("opensesame.settings")).not.toBe("ours");
    expect(local.getItem("opensesame:federation:session")).not.toBe("ours too");
    expect(local.getItem("theirs")).toBe("not ours");
    expect(local.getItem("opensesame:session")).toBe("a relying party's");
    expect(sealLegacyWebStorage("local")).toBe(0);
    // Sealed once, not again: the ports read the value back as it was.
    expect(localStore().getItem("opensesame.settings")).toBe("ours");
  });

  it("never seals twice when a sealed value is already there", () => {
    localStore().setItem("opensesame:federation:pkce", '{"state":"s"}');
    const before = local.getItem("opensesame:federation:pkce");
    expect(sealLegacyWebStorage("local")).toBe(0);
    expect(local.getItem("opensesame:federation:pkce")).toBe(before);
    expect(localStore().getItem("opensesame:federation:pkce")).toBe(
      '{"state":"s"}',
    );
  });
});

describe("before the key loads", () => {
  it("holds writes in memory, never on disk, and seals them when it lands", async () => {
    const keys = deferredKeys();
    install(keys);

    localStore().setItem("opensesame.join", "bearer");
    expect(local.getItem("opensesame.join")).toBeNull();
    expect(localStore().getItem("opensesame.join")).toBe("bearer");

    keys.resolve(KEY);
    await atRestReady();
    const raw = local.getItem("opensesame.join") ?? "";
    expect(isSealedAtRest(raw)).toBe(true);
    expect(localStore().getItem("opensesame.join")).toBe("bearer");
  });

  it("refuses to read a sealed value rather than call it absent", () => {
    install(deferredKeys());
    local.setItem(
      "opensesame.settings",
      sealAtRest(
        KEY,
        atRestBinding("web-storage.local", "opensesame.settings"),
        "x",
      ),
    );
    expect(() => localStore().getItem("opensesame.settings")).toThrow(
      AtRestKeyPendingError,
    );
    expect(localStore().getItem("opensesame.absent")).toBeNull();
  });
});

describe("with no key the host can keep", () => {
  it("keeps writes in memory only when the host has no key store", () => {
    install(undefined);
    localStore().setItem("opensesame.settings", "session only");
    expect(local.length).toBe(0);
    expect(localStore().getItem("opensesame.settings")).toBe("session only");
    expect(atRestSettled()?.durable).toBe(false);
  });

  it("goes ephemeral when the key will not load, and overwrites nothing", async () => {
    const keys = deferredKeys();
    install(keys);
    local.setItem("opensesame.settings", "sealed by a key we cannot reach");
    localStore().setItem("opensesame.other", "new");
    keys.reject();
    const settled = await atRestReady();
    expect(settled.durable).toBe(false);
    expect(local.getItem("opensesame.other")).toBeNull();
    expect(local.getItem("opensesame.settings")).toBe(
      "sealed by a key we cannot reach",
    );
    expect(localStore().getItem("opensesame.other")).toBe("new");
  });

  it("goes ephemeral when a synchronous key is the wrong length", () => {
    install({ loadSync: () => new Uint8Array(3), load: async () => KEY });
    expect(atRestKeyNow()?.durable).toBe(false);
  });
});
