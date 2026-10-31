import { describe, expect, it } from "vitest";
import { PENDING_KEY, createHostBook } from "./hosts.js";
import { fakePorts } from "./test-ports.js";

const table = [
  { providerId: "plivo", authorities: ["api.plivo.com"] },
  {
    providerId: "datadog",
    authorities: ["api.datadoghq.com", "api.datadoghq.eu"],
  },
] as const;

describe("the hosts a person may allow", () => {
  it("records a page's ask for hosts the table names, and drops the rest", async () => {
    const fake = fakePorts();
    const book = createHostBook(fake.ports, table);
    expect(
      await book.ask(["api.plivo.com", "evil.test", "api.plivo.com"]),
    ).toEqual(["api.plivo.com"]);
    expect(fake.state.badge).toBe("1");
    expect(JSON.parse(fake.asks.get(PENDING_KEY) ?? "[]")).toEqual([
      "api.plivo.com",
    ]);
  });

  it("calls a host granted only when the browser holds it and the table names it", async () => {
    const fake = fakePorts();
    const book = createHostBook(fake.ports, table);
    fake.hosts.add("api.plivo.com");
    fake.hosts.add("some.other.example");
    expect(await book.granted()).toEqual(["api.plivo.com"]);
  });

  it("retires an ask once the browser grants the host", async () => {
    const fake = fakePorts();
    const book = createHostBook(fake.ports, table);
    await book.ask(["api.plivo.com", "api.datadoghq.com"]);
    fake.hosts.add("api.plivo.com");
    expect(await book.pending()).toEqual(["api.datadoghq.com"]);
    await book.reconcile();
    expect(fake.state.badge).toBe("1");
    expect(JSON.parse(fake.asks.get(PENDING_KEY) ?? "[]")).toEqual([
      "api.datadoghq.com",
    ]);
  });

  it("gives a grant back, and only for a host the table names", async () => {
    const fake = fakePorts();
    const book = createHostBook(fake.ports, table);
    fake.hosts.add("api.plivo.com");
    fake.hosts.add("some.other.example");
    await book.revoke("some.other.example");
    expect(fake.hosts.has("some.other.example")).toBe(true);
    await book.revoke("api.plivo.com");
    expect(fake.hosts.has("api.plivo.com")).toBe(false);
  });

  it("bounds what it remembers, and reads a damaged list as empty", async () => {
    const fake = fakePorts();
    const wide = Array.from({ length: 100 }, (_, i) => `h${i}.example.com`);
    const book = createHostBook(fake.ports, [
      { providerId: "wide", authorities: wide },
    ]);
    await book.ask(wide.slice(0, 16));
    await book.ask(wide.slice(16, 32));
    await book.ask(wide.slice(32, 48));
    await book.ask(wide.slice(48, 64));
    await book.ask(wide.slice(64, 80));
    expect((await book.pending()).length).toBe(64);
    fake.asks.set(PENDING_KEY, "{");
    expect(await book.pending()).toEqual([]);
  });

  it("names the providers whose key check goes to a host", () => {
    const book = createHostBook(fakePorts().ports, table);
    expect(book.providersOf("api.datadoghq.eu")).toEqual(["datadog"]);
    expect(book.providersOf("nope.example")).toEqual([]);
  });

  it("takes the Origin header off requests to the hosts a person granted, and only those", async () => {
    const fake = fakePorts();
    const book = createHostBook(fake.ports, table);
    expect(await book.readyToSend()).toEqual([]);
    expect(fake.bare).toEqual([]);
    fake.hosts.add("api.plivo.com");
    fake.hosts.add("some.other.example");
    expect(await book.readyToSend()).toEqual(["api.plivo.com"]);
    expect(fake.bare).toEqual(["api.plivo.com"]);
  });

  it("follows a grant taken back, and applies the rule again when a worker starts with none", async () => {
    const fake = fakePorts();
    const book = createHostBook(fake.ports, table);
    fake.hosts.add("api.plivo.com");
    await book.readyToSend();
    fake.hosts.delete("api.plivo.com");
    await book.reconcile();
    expect(fake.bare).toEqual([]);

    // A new worker has not applied anything, whatever the browser kept.
    fake.hosts.add("api.datadoghq.eu");
    fake.bare.length = 0;
    const fresh = createHostBook(fake.ports, table);
    await fresh.readyToSend();
    expect(fake.bare).toEqual(["api.datadoghq.eu"]);
  });
});

describe("a tenant a page asked for (ADR 0217)", () => {
  it("is kept in memory only, never in the extension's persistent storage", async () => {
    const fake = fakePorts();
    const book = createHostBook(fake.ports, [
      { providerId: "okta", authorities: [], tenants: ["*.okta.com"] },
    ]);
    await book.ask(["acme.okta.com"]);
    expect(JSON.parse(fake.asks.get(PENDING_KEY) ?? "[]")).toEqual([
      "acme.okta.com",
    ]);
    expect(fake.store.has(PENDING_KEY)).toBe(false);
    expect([...fake.store.values()].join()).not.toContain("acme.okta.com");
  });
});
