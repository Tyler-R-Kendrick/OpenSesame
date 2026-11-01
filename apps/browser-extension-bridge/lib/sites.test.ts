import { describe, expect, it } from "vitest";
import { SITES_KEY, createSiteRegistry, relayId, webOrigin } from "./sites.js";
import { fakePorts } from "./test-ports.js";

const APP = "https://opensesame-labs.github.io";

describe("webOrigin", () => {
  it.each([
    [APP, APP],
    [`${APP}/OpenSesame/`, APP],
    ["http://localhost:5180/x", "http://localhost:5180"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
  ])("reads %s as %s", (value, origin) =>
    expect(webOrigin(value)).toBe(origin),
  );

  it.each([
    "http://example.com",
    "ftp://example.com",
    "javascript:alert(1)",
    "chrome://settings",
    "not a url",
    "https://user:pw@example.com",
    "",
  ])("refuses %j", (value) => expect(webOrigin(value)).toBeNull());
});

describe("the sites a person switched on", () => {
  it("switches an origin on only once the browser holds its grant, and registers the relay for it alone", async () => {
    const fake = fakePorts();
    const sites = createSiteRegistry(fake.ports);
    expect(await sites.enable(APP)).toBe("permission_not_granted");
    expect(fake.registered.size).toBe(0);
    fake.origins.add(APP);
    expect(await sites.enable(`${APP}/OpenSesame/`)).toBe("enabled");
    expect([...fake.registered.entries()]).toEqual([[relayId(APP), APP]]);
    expect(await sites.isEnabled(APP)).toBe(true);
    expect(await sites.list()).toEqual([APP]);
  });

  it("refuses an origin that is not one", async () => {
    const fake = fakePorts();
    expect(
      await createSiteRegistry(fake.ports).enable("http://example.com"),
    ).toBe("invalid_origin");
  });

  it("switching off unregisters the relay and gives the grant back", async () => {
    const fake = fakePorts();
    fake.origins.add(APP);
    const sites = createSiteRegistry(fake.ports);
    await sites.enable(APP);
    await sites.disable(APP);
    expect(fake.registered.size).toBe(0);
    expect(fake.origins.has(APP)).toBe(false);
    expect(await sites.isEnabled(APP)).toBe(false);
  });

  it("is on only while the list, the grant and the registration agree", async () => {
    const fake = fakePorts();
    fake.origins.add(APP);
    const sites = createSiteRegistry(fake.ports);
    await sites.enable(APP);
    fake.origins.delete(APP);
    expect(await sites.isEnabled(APP)).toBe(false);
    await sites.reconcile();
    expect(await sites.list()).toEqual([]);
    expect(fake.registered.size).toBe(0);
  });

  it("reads a damaged list as empty", async () => {
    const fake = fakePorts();
    for (const damaged of ["{", "{}", '[5,"http://example.com"]']) {
      fake.store.set(SITES_KEY, damaged);
      expect(await createSiteRegistry(fake.ports).list()).toEqual([]);
    }
  });

  it("names a registration by hex, so no origin character reaches the id", () => {
    expect(relayId(APP)).toMatch(/^relay-[0-9a-f]+$/);
  });
});
