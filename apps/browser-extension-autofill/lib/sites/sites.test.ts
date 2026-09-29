import { beforeEach, describe, expect, it } from "vitest";
import { DAEMON_PATTERN } from "./patterns";
import { type SitePorts, createSiteRegistry, scriptId } from "./sites";

interface Fake {
  ports: SitePorts;
  granted: Set<string>;
  scripts: Map<string, string>;
  removed: string[];
}

function fake(): Fake {
  const granted = new Set<string>();
  const scripts = new Map<string, string>();
  const removed: string[] = [];
  const stored = new Map<string, string>();
  return {
    granted,
    scripts,
    removed,
    ports: {
      hasPermission: async (pattern) => granted.has(pattern),
      removePermission: async (pattern) => {
        removed.push(pattern);
        granted.delete(pattern);
      },
      registeredIds: async () => [...scripts.keys()],
      register: async (id, pattern) => {
        if (scripts.has(id)) throw new Error(`duplicate id ${id}`);
        scripts.set(id, pattern);
      },
      unregister: async (id) => {
        scripts.delete(id);
      },
      store: {
        get: async (key) => stored.get(key),
        set: async (key, value) => {
          stored.set(key, value);
        },
      },
    },
  };
}

const SITE = "https://example.com";
let f: Fake;

beforeEach(() => {
  f = fake();
});

describe("sites a person switched on", () => {
  it("a site nobody switched on is off, with no script anywhere", async () => {
    const sites = createSiteRegistry(f.ports);
    expect(await sites.isEnabled(SITE)).toBe(false);
    expect(f.scripts.size).toBe(0);
  });

  it("switching on without the browser's grant registers nothing", async () => {
    const sites = createSiteRegistry(f.ports);
    expect(await sites.enable(SITE)).toBe("permission_not_granted");
    expect(f.scripts.size).toBe(0);
    expect(await sites.isEnabled(SITE)).toBe(false);
  });

  it("a non-web page can never be switched on", async () => {
    const sites = createSiteRegistry(f.ports);
    f.granted.add("https://*/*");
    for (const origin of [
      "chrome://settings",
      "file:///etc/passwd",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      "https://example.com/login",
      "null",
    ]) {
      expect(await sites.enable(origin), origin).toBe("invalid_origin");
    }
    expect(f.scripts.size).toBe(0);
  });

  it("switching on registers the guard for that one host, idempotently", async () => {
    const sites = createSiteRegistry(f.ports);
    f.granted.add("https://example.com/*");
    expect(await sites.enable(SITE)).toBe("enabled");
    expect(await sites.enable(SITE)).toBe("enabled");
    expect([...f.scripts]).toEqual([[scriptId(SITE), "https://example.com/*"]]);
    expect(await sites.isEnabled(SITE)).toBe(true);
    expect(await sites.list()).toEqual([SITE]);
  });

  it("switching one port on leaves every other port of that host off", async () => {
    const sites = createSiteRegistry(f.ports);
    f.granted.add("https://example.com/*");
    await sites.enable(SITE);
    expect(await sites.isEnabled("https://example.com:8443")).toBe(false);
    expect(await sites.isEnabled("http://example.com")).toBe(false);
    expect(await sites.isEnabled("https://www.example.com")).toBe(false);
  });

  it("switching off unregisters the guard and gives the host back", async () => {
    const sites = createSiteRegistry(f.ports);
    f.granted.add("https://example.com/*");
    await sites.enable(SITE);
    await sites.disable(SITE);
    expect(f.scripts.size).toBe(0);
    expect(f.removed).toEqual(["https://example.com/*"]);
    expect(await sites.isEnabled(SITE)).toBe(false);
  });

  it("switching one port off keeps the grant another switched-on port still needs", async () => {
    const sites = createSiteRegistry(f.ports);
    f.granted.add("https://example.com/*");
    await sites.enable(SITE);
    await sites.enable("https://example.com:8443");
    await sites.disable(SITE);
    expect(f.removed).toEqual([]);
    expect(await sites.isEnabled("https://example.com:8443")).toBe(true);
  });

  it("switching off a loopback site never gives back the daemon's grant", async () => {
    const sites = createSiteRegistry(f.ports);
    f.granted.add(DAEMON_PATTERN);
    const local = "http://127.0.0.1:3000";
    await sites.enable(local);
    await sites.disable(local);
    expect(f.removed).toEqual([]);
    expect(f.granted.has(DAEMON_PATTERN)).toBe(true);
    expect(await sites.isEnabled(local)).toBe(false);
  });

  it("a grant the person took back in the browser switches the site off", async () => {
    const sites = createSiteRegistry(f.ports);
    f.granted.add("https://example.com/*");
    await sites.enable(SITE);
    f.granted.delete("https://example.com/*");
    expect(await sites.isEnabled(SITE)).toBe(false);
    await sites.reconcile();
    expect(f.scripts.size).toBe(0);
    expect(await sites.list()).toEqual([]);
  });

  it("a registration that vanished reads as off", async () => {
    const sites = createSiteRegistry(f.ports);
    f.granted.add("https://example.com/*");
    await sites.enable(SITE);
    f.scripts.clear();
    expect(await sites.isEnabled(SITE)).toBe(false);
  });

  it("a tampered site list switches nothing on", async () => {
    const sites = createSiteRegistry(f.ports);
    await f.ports.store.set("fillSites", '{"not":"a list"}');
    expect(await sites.list()).toEqual([]);
    await f.ports.store.set("fillSites", '["javascript:alert(1)", 7]');
    expect(await sites.list()).toEqual([]);
  });

  it("gives each origin its own script id", () => {
    expect(scriptId(SITE)).not.toBe(scriptId("https://example.com:8443"));
    expect(scriptId(SITE)).toMatch(/^fill-guard-[0-9a-f]+$/);
  });
});
