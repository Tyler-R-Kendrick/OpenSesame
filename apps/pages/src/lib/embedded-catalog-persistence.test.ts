import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeDb = {
  store: Map<string, string>;
  exec: () => Promise<void>;
  prepare: (sql: string) => Promise<{
    get: (key: string) => Promise<{ value: string } | undefined>;
    run: (key: string, value: string) => Promise<void>;
  }>;
  pull: () => Promise<boolean>;
  push: () => Promise<void>;
  close: () => Promise<void>;
};

const state = vi.hoisted(() => ({
  dbs: [] as FakeDb[],
  connectError: null as Error | null,
  pullError: null as Error | null,
  hang: false,
  lastConnectOptions: null as Record<string, unknown> | null,
}));

vi.mock("@tursodatabase/sync-wasm/vite", () => ({
  connect: (options: Record<string, unknown>) => {
    state.lastConnectOptions = options;
    if (state.connectError) return Promise.reject(state.connectError);
    if (state.hang) return new Promise(() => {});
    const store = new Map<string, string>();
    const db: FakeDb = {
      store,
      exec: () => Promise.resolve(),
      prepare: () =>
        Promise.resolve({
          get: (key: string) =>
            Promise.resolve(
              store.has(key) ? { value: store.get(key) ?? "" } : undefined,
            ),
          run: (key: string, value: string) => {
            store.set(key, value);
            return Promise.resolve();
          },
        }),
      pull: () =>
        state.pullError
          ? Promise.reject(state.pullError)
          : Promise.resolve(true),
      push: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    state.dbs.push(db);
    return Promise.resolve(db);
  },
}));

import {
  bundledProviders,
  checkTurso,
  decodeEmbeddedProviders,
  readEmbeddedProviders,
  setTursoSessionToken,
  tursoMode,
  writeEmbeddedProviders,
} from "./embedded-catalog.js";
import { loadSettings, saveSettings } from "./settings.js";

beforeEach(() => {
  state.dbs = [];
  state.connectError = null;
  state.pullError = null;
  state.hang = false;
  state.lastConnectOptions = null;
  setTursoSessionToken("");
  saveSettings({
    ...loadSettings(),
    tursoUrl: "",
  });
});

afterEach(() => {
  setTursoSessionToken("");
  vi.useRealTimers();
});

describe("embedded catalog persistence", () => {
  it("opens an embedded database and seeds it with the bundled catalog", async () => {
    const providers = await readEmbeddedProviders();
    expect(providers).toEqual(bundledProviders);
    expect(tursoMode()).toBe("embedded");
    expect(state.lastConnectOptions).toMatchObject({
      path: "opensesame-connectors.db",
      clientName: "opensesame-pages",
    });
    expect(state.lastConnectOptions?.url).toBeUndefined();
    // The empty cache was backfilled.
    const cached = state.dbs[0]?.store.get("providers");
    expect(cached).toBeTruthy();
    expect(decodeEmbeddedProviders(cached ?? "")).toEqual(bundledProviders);
  });

  it("serves the cached catalog on the next read", async () => {
    await writeEmbeddedProviders(bundledProviders);
    await expect(readEmbeddedProviders()).resolves.toEqual(bundledProviders);
  });

  it("decodes only the exact bundled revision with valid rows", () => {
    expect(decodeEmbeddedProviders("not json")).toBeNull();
    expect(decodeEmbeddedProviders(JSON.stringify(null))).toBeNull();
    expect(
      decodeEmbeddedProviders(
        JSON.stringify({ revision: "2026-08-13.1", providers: "nope" }),
      ),
    ).toBeNull();
    expect(
      decodeEmbeddedProviders(
        JSON.stringify({ revision: "2026-08-13.1", providers: [] }),
      ),
    ).toBeNull();
    expect(
      decodeEmbeddedProviders(
        JSON.stringify({
          revision: "2026-08-13.1",
          providers: [{ id: 42 }],
        }),
      ),
    ).toBeNull();
  });

  it("falls back to memory mode when the database cannot open", async () => {
    state.connectError = new Error("wasm unavailable");
    await expect(readEmbeddedProviders()).resolves.toEqual(bundledProviders);
    expect(tursoMode()).toBe("memory");
  });

  it("never blocks the gallery on a hung database open", async () => {
    vi.useFakeTimers();
    state.hang = true;
    const pending = readEmbeddedProviders();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual(bundledProviders);
    expect(tursoMode()).toBe("memory");
  });

  it("reports checkTurso failures as memory mode", async () => {
    await expect(checkTurso()).resolves.toBe("embedded");
    setTursoSessionToken("");
    state.connectError = new Error("down");
    await expect(checkTurso()).resolves.toBe("memory");
  });

  it("uses remote mode when Turso URL and token are configured", async () => {
    saveSettings({
      ...loadSettings(),
      tursoUrl: "libsql://example.turso.io",
    });
    setTursoSessionToken("token-1");

    await readEmbeddedProviders();

    expect(tursoMode()).toBe("remote");
    expect(state.lastConnectOptions?.url).toBe("libsql://example.turso.io");
    expect(typeof state.lastConnectOptions?.authToken).toBe("function");

    // A failed pull degrades to embedded rather than breaking the gallery.
    setTursoSessionToken("token-1");
    state.pullError = new Error("unreachable");
    await readEmbeddedProviders();
    expect(tursoMode()).toBe("embedded");
  });

  it("swallows write failures and marks the mode memory", async () => {
    // First get a working db cached, then break prepare by resetting with a
    // failing connect.
    await expect(
      writeEmbeddedProviders(bundledProviders),
    ).resolves.toBeUndefined();
    setTursoSessionToken("");
    state.connectError = new Error("gone");
    await expect(
      writeEmbeddedProviders(bundledProviders),
    ).resolves.toBeUndefined();
    expect(tursoMode()).toBe("memory");
  });

  it("closes the previous database when the session token changes", async () => {
    await readEmbeddedProviders();
    const db = state.dbs[0];
    const close = vi.spyOn(db as FakeDb, "close");
    setTursoSessionToken("new-token");
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });
});
