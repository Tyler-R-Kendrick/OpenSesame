/**
 * The seam between a live session and the connections an app holds
 * (ADR 0195): what is offered to a device is always something the wire can
 * carry, and a binding belongs to the activation that made it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type ConnectionPort,
  bindConnectionPort,
  connectionPort,
  offeredBy,
  onConnectionPort,
  revealsSecret,
  wireConnection,
} from "./connection-port.js";
import { OPERATIONS_MAX } from "./device-messages.js";

const port = (): ConnectionPort => ({
  list: () => [],
  invoke: async () => ({ label: "", items: [] }),
});

describe("what a device is offered", () => {
  it("cleans a label the owner typed, and falls back to the id", () => {
    const wire = (label: string) =>
      wireConnection({ id: "c-1", label, provider: "github", operations: [] });
    expect(wire("Work‮ GitHub\n(admin)")?.label).toBe("Work GitHub (admin)");
    expect(wire("   ")?.label).toBe("c-1");
    expect(wire("\u0000​")?.label).toBe("c-1");
    expect(wire("é".repeat(500))?.label).toHaveLength(120);
  });

  it("does not offer a connection the wire cannot name", () => {
    const held = { label: "x", provider: "github", operations: [] };
    expect(wireConnection({ ...held, id: "has space" })).toBeNull();
    expect(wireConnection({ ...held, id: "" })).toBeNull();
    expect(wireConnection({ ...held, id: "a".repeat(129) })).toBeNull();
  });

  it("calls an unspellable provider other", () => {
    expect(
      wireConnection({ id: "c", label: "x", provider: "a b", operations: [] })
        ?.provider,
    ).toBe("other");
  });

  it("lists only operations the wire can carry, never one that reads a secret", () => {
    const operations = [
      "provider.read",
      "provider.secret.read",
      "Bad Op",
      "mcp.tools.list",
      "provider.token.read",
      "provider.api_key.read",
      "provider.apikey.read",
      "provider.credentials.list",
      "provider.password.read",
    ];
    expect(
      wireConnection({ id: "c", label: "x", provider: "p", operations })
        ?.operations,
    ).toEqual(["provider.read", "mcp.tools.list"]);
  });

  it("offers at most as many operations as the wire allows", () => {
    const operations = Array.from({ length: 40 }, (_, i) => `op.n${i}`);
    expect(
      wireConnection({ id: "c", label: "x", provider: "p", operations })
        ?.operations,
    ).toHaveLength(OPERATIONS_MAX);
  });

  it("offers nothing without a port", () => {
    expect(offeredBy(null)).toEqual([]);
    const listing: ConnectionPort = {
      ...port(),
      list: () => [
        { id: "ok", label: "Ok", provider: "p", operations: ["provider.read"] },
        { id: "bad id", label: "Bad", provider: "p", operations: [] },
      ],
    };
    expect(offeredBy(listing).map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("knows an operation that would read a secret by its name", () => {
    expect(revealsSecret("provider.secret.read")).toBe(true);
    expect(revealsSecret("provider.Secret.read")).toBe(true);
    expect(revealsSecret("provider.read")).toBe(false);
    expect(revealsSecret("provider.repositories.read")).toBe(false);
    expect(revealsSecret("mcp.tools.list")).toBe(false);
  });
});

describe("binding the port", () => {
  it("is the bound port until released, and tells watchers", () => {
    const heard = vi.fn();
    const stop = onConnectionPort(heard);
    expect(connectionPort()).toBeNull();
    const mine = port();
    const release = bindConnectionPort(mine);
    expect(connectionPort()).toBe(mine);
    release();
    expect(connectionPort()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it("is replaced by a later binding, whose release is the only one that counts", () => {
    const first = port();
    const second = port();
    const releaseFirst = bindConnectionPort(first);
    const releaseSecond = bindConnectionPort(second);
    expect(connectionPort()).toBe(second);
    releaseFirst();
    expect(connectionPort()).toBe(second);
    releaseSecond();
    expect(connectionPort()).toBeNull();
  });
});
