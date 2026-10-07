import { isSealedForRest } from "@opensesame/browser-at-rest";
import {
  type BoundaryObject,
  type BoundaryValue,
  isString,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_HOST, resolveHostBase } from "./host-base";
import { SealedKv, browserStore } from "./store";
import { useTestDeviceKey } from "./test-support/memory";

const rows = new Map<string, BoundaryValue>();

beforeEach(() => {
  rows.clear();
  useTestDeviceKey();
  vi.stubGlobal("browser", {
    storage: {
      local: {
        async get(key: string | null): Promise<BoundaryObject> {
          if (key === null) return Object.fromEntries(rows);
          return rows.has(key) ? { [key]: rows.get(key) } : {};
        },
        async set(values: BoundaryObject) {
          for (const [key, value] of Object.entries(values))
            rows.set(key, value);
        },
        async remove(key: string) {
          rows.delete(key);
        },
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("rejects non-string storage values at both runner and host boundaries", async () => {
  for (const malformed of [
    null,
    1,
    true,
    [],
    {},
    { toString: () => DEFAULT_HOST },
  ]) {
    rows.set("hostApiBase", malformed);
    rows.set("runner.token", malformed);
    expect(await resolveHostBase()).toBe(DEFAULT_HOST);
    expect(await browserStore().get("runner.token")).toBeUndefined();
    expect(await new SealedKv(browserStore()).get("token")).toBeNull();
  }
});

it("keeps a legacy loopback configuration sealed and rejects remote configuration", async () => {
  const host = "http://127.0.0.1:9876";
  rows.set("hostApiBase", host);
  expect(await resolveHostBase()).toBe(host);
  const stored = rows.get("hostApiBase");
  expect(isString(stored)).toBe(true);
  if (!isString(stored)) throw new Error("expected sealed string");
  expect(isSealedForRest(stored)).toBe(true);
  expect(stored).not.toContain(host);
  expect(await resolveHostBase()).toBe(host);
  rows.set("hostApiBase", "https://remote.example");
  expect(await resolveHostBase()).toBe(DEFAULT_HOST);
});

it("round-trips only sealed runner strings and removes clear-text legacy values", async () => {
  const raw = browserStore();
  const sealed = new SealedKv(raw);
  await sealed.set("token", "synthetic session fixture");
  expect(await sealed.get("token")).toBe("synthetic session fixture");
  expect(rows.get("runner.token")).not.toContain("synthetic session fixture");
  expect(await raw.keys()).toEqual(["runner.token"]);
  rows.set("runner.token", "clear-text legacy fixture");
  expect(await sealed.get("token")).toBeNull();
  expect(rows.has("runner.token")).toBe(false);
});
