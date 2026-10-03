import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserGrants, browserPages, closeRunTab } from "./browser";
import { RunnerSettings } from "./settings";
import { SealedKv } from "./store";
import { FakeBrowser } from "./test-support/fake-browser";
import { MemoryStore, useTestDeviceKey } from "./test-support/memory";
import { RP, Site } from "./test-support/site";

let fake: FakeBrowser;
let settings: RunnerSettings;

beforeEach(() => {
  useTestDeviceKey();
  fake = new FakeBrowser(new Site("pw"));
  fake.install();
  settings = new RunnerSettings(new SealedKv(new MemoryStore()));
});
afterEach(() => vi.unstubAllGlobals());

async function pages() {
  fake.granted.permissions.add("scripting");
  fake.granted.origins.add(`${RP}/*`);
  const factory = browserPages(settings);
  const opened = await factory({ id: "run:1", origin: RP });
  if (!opened) throw new Error("no pages");
  return opened;
}

describe("grants", () => {
  it("holds a grant only with both the origin and the scripting permission", async () => {
    const grants = browserGrants();
    expect(await grants.has(RP)).toBe(false);
    fake.granted.origins.add(`${RP}/*`);
    expect(await grants.has(RP)).toBe(false);
    fake.granted.permissions.add("scripting");
    expect(await grants.has(RP)).toBe(true);
    expect(await grants.has("https://other.example")).toBe(false);
  });

  it("gives an origin back, and scripting with the last one", async () => {
    const grants = browserGrants();
    fake.granted.permissions.add("scripting");
    fake.granted.origins.add(`${RP}/*`);
    fake.granted.origins.add("https://two.example/*");
    await grants.revoke(RP);
    expect(fake.granted.origins.has(`${RP}/*`)).toBe(false);
    expect(fake.granted.permissions.has("scripting")).toBe(true);
    await grants.revoke("https://two.example");
    expect(fake.granted.permissions.has("scripting")).toBe(false);
  });

  it("cannot take back what the manifest declares, and does not mind", async () => {
    await expect(
      browserGrants().revoke("http://127.0.0.1"),
    ).resolves.toBeUndefined();
  });

  it("asks the browser whether a private window is allowed", async () => {
    expect(await browserGrants().privateAllowed()).toBe(true);
    fake.incognitoAllowed = false;
    expect(await browserGrants().privateAllowed()).toBe(false);
  });
});

describe("the run's page", () => {
  it("opens one background tab, remembers it, and finds it again after a restart", async () => {
    const first = await pages();
    expect(fake.tabs.size).toBe(1);
    expect([...fake.tabs.values()][0]?.incognito).toBe(false);
    const held = (await settings.active()).get("run:1");
    expect(held?.tabId).toBe([...fake.tabs.keys()][0]);
    await browserPages(settings)({ id: "run:1", origin: RP });
    expect(fake.tabs.size).toBe(1);
    void first;
  });

  it("opens a new tab when the remembered one is gone", async () => {
    await pages();
    fake.tabs.clear();
    await browserPages(settings)({ id: "run:1", origin: RP });
    expect(fake.tabs.size).toBe(1);
  });

  it("navigates, fills, checks and submits through injected page functions", async () => {
    const p = await pages();
    expect(await p.navigate(`${RP}/account/password`)).toBe("ok");
    expect(await p.waitFor("#new")).toBe("ok");
    expect(await p.fill("#new", "abc")).toBe("ok");
    expect(await p.presence("#new", "abc")).toBe("present");
    expect(await p.submit("#go")).toBe("ok");
    expect(await p.readDom([])).toContain("<form");
    expect(fake.injected).toEqual([
      "pfWaitFor",
      "pfFill",
      "pfPresence",
      "pfSubmit",
      "pfReadDom",
    ]);
  });

  it("answers navigation when the tab ends up anywhere but the run's origin", async () => {
    const p = await pages();
    expect(await p.navigate("https://evil.example/")).toBe("navigation");
  });

  it("will not inject into a tab that has left the origin", async () => {
    const p = await pages();
    await p.navigate(`${RP}/account/password`);
    const [id] = [...fake.tabs.keys()];
    if (id === undefined) throw new Error("no tab");
    fake.navigateTab(id, "https://evil.example/");
    const before = fake.injected.length;
    await expect(p.fill("#new", "x")).rejects.toThrow("off_origin");
    expect(fake.injected).toHaveLength(before);
  });

  it("waits out a navigation and looks again, for a step that can be repeated", async () => {
    const p = await pages();
    await p.navigate(`${RP}/account/password`);
    fake.failNextInjection = new Error("Frame with ID 0 was removed");
    const [id] = [...fake.tabs.keys()];
    if (id !== undefined) fake.navigateTab(id, `${RP}/account/password`);
    expect(await p.fill("#new", "abc")).toBe("ok");
    expect(fake.injected.at(-1)).toBe("pfFill");
  });

  it("never retries a submit, and reads a torn-down frame after navigation as the click it was", async () => {
    const p = await pages();
    await p.navigate(`${RP}/account/password`);
    const [id] = [...fake.tabs.keys()];
    fake.failNextInjection = new Error("Frame with ID 0 was removed");
    // The click navigated the tab before it could answer.
    const submitting = p.submit("#go");
    if (id !== undefined) fake.navigateTab(id, `${RP}/account/password/done`);
    expect(await submitting).toBe("ok");
    // Exactly one attempt: a second click would be a second submit.
    expect(fake.injected).toEqual(["pfSubmit"]);
  });

  it("a submit that failed without navigating is an error, not a pass", async () => {
    const p = await pages();
    await p.navigate(`${RP}/account/password`);
    fake.failNextInjection = new Error("boom");
    await expect(p.submit("#go")).rejects.toThrow("boom");
  });

  it("masks, stills at the best quality that fits, and unmasks", async () => {
    const p = await pages();
    await p.navigate(`${RP}/account/password`);
    fake.stillBytes = (quality) => (quality > 25 ? 400_000 : 100_000);
    const taken = await p.capture(["#new", "#current"]);
    expect(taken?.covered).toBe(2);
    expect(taken?.image).toHaveLength(100_000);
    expect(fake.captures).toEqual([60, 40, 25]);
    expect(taken?.before).toBe(taken?.after);
    expect(fake.injected.at(-1)).toBe("pfUnmask");
    expect(fake.injected).toContain("pfMask");
  });

  it("gives up on a still that is too big at every quality, and still unmasks", async () => {
    const p = await pages();
    await p.navigate(`${RP}/account/password`);
    fake.stillBytes = () => 900_000;
    expect(await p.capture(["#new"])).toBeNull();
    expect(fake.captures).toHaveLength(4);
    expect(fake.injected.at(-1)).toBe("pfUnmask");
  });

  it("opens a private window for a fresh login, drives it, and closes it", async () => {
    const p = await pages();
    const before = fake.tabs.size;
    const clean = await p.fresh();
    expect(clean).not.toBeNull();
    expect([...fake.tabs.values()].filter((t) => t.incognito)).toHaveLength(1);
    expect(await clean?.navigate(`${RP}/login`)).toBe("ok");
    expect(await clean?.waitFor("#pass")).toBe("ok");
    await clean?.close();
    expect(fake.tabs.size).toBe(before);
  });

  it("opens none when private windows are not allowed", async () => {
    const p = await pages();
    fake.incognitoAllowed = false;
    expect(await p.fresh()).toBeNull();
    expect([...fake.tabs.values()].some((t) => t.incognito)).toBe(false);
  });

  it("closes the run's tab, and a tab already gone is already closed", async () => {
    const p = await pages();
    const held = (await settings.active()).get("run:1")?.tabId ?? null;
    await closeRunTab(held);
    expect(fake.tabs.size).toBe(0);
    await expect(closeRunTab(held)).resolves.toBeUndefined();
    await expect(closeRunTab(null)).resolves.toBeUndefined();
    void p;
  });
});
