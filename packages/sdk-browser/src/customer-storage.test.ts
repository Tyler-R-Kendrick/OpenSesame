import { expect, it } from "vitest";
import { createSessionStore } from "./session-store.js";
import { legacyFixtureValue } from "./test/storage-fixture.js";

it("binds browser SDK credentials and PKCE state to trusted issuer/client scope", async () => {
  const rows = new Map<string, string>();
  const storage = {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: (key: string) => {
      rows.delete(key);
    },
  };
  const first = createSessionStore(
    storage,
    JSON.stringify(["sdk-browser", "https://customer-a.example", "client-a"]),
  );
  await first.savePkce("customer-a-verifier");
  expect(rows.get("opensesame:pkce")).toMatch(/^osc2\./);
  for (const scope of [
    ["sdk-browser", "https://customer-b.example", "client-a"],
    ["sdk-browser", "https://customer-a.example", "client-b"],
  ]) {
    const other = createSessionStore(storage, JSON.stringify(scope));
    expect(await other.sealed.get("opensesame:pkce")).toBeNull();
  }
  expect(await first.takePkce()).toBe("customer-a-verifier");
});

it("discards old unscoped SDK credentials instead of assigning customer A to B", async () => {
  const { createConfiguredSessionStore } = await import("./session-store.js");
  const { openFromRest } = await import("@opensesame/browser-at-rest");
  const rows = new Map<string, string>();
  const storage = {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: (key: string) => {
      rows.delete(key);
    },
  };
  const oldSession = JSON.stringify({
    accessToken: "customer-a-bearer",
    anonymous: true,
    raw: {},
  });
  const oldSeal = legacyFixtureValue("opensesame:session", oldSession);
  expect(await openFromRest("sdk-browser", "opensesame:session", oldSeal)).toBe(
    oldSession,
  );
  for (const legacy of [oldSession, oldSeal]) {
    rows.set("opensesame:session", legacy);
    rows.set("opensesame:pkce", "customer-a-verifier");
    const customerB = createConfiguredSessionStore(
      storage,
      "https://customer-b.example",
      "client-b",
    );
    expect(await customerB.readSession()).toBeNull();
    expect(await customerB.takePkce()).toBeNull();
    expect(rows.size).toBe(0);
  }
});
