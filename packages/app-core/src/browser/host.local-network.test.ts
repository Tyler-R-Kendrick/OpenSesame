/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPorts } from "./host.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function withPermission(
  query: (descriptor: { name: string }) => Promise<{ state: string }>,
) {
  vi.stubGlobal("navigator", { permissions: { query } });
  return browserPorts().environment?.localNetworkPermission;
}

describe("Local Network Access permission names", () => {
  it("asks for loopback-network for a loopback destination", async () => {
    const query = vi.fn(async () => ({ state: "granted" }));
    const permission = withPermission(query);
    await expect(permission?.("loopback")).resolves.toBe("granted");
    expect(query).toHaveBeenCalledWith({ name: "loopback-network" });
  });

  it("asks for local-network for a LAN destination", async () => {
    const query = vi.fn(async () => ({ state: "prompt" }));
    const permission = withPermission(query);
    await expect(permission?.("local")).resolves.toBe("prompt");
    expect(query).toHaveBeenCalledWith({ name: "local-network" });
  });

  it("falls back to the original alias for older Chromium", async () => {
    const query = vi.fn(async ({ name }: { name: string }) => {
      if (name !== "local-network-access") throw new Error("unknown");
      return { state: "denied" };
    });
    const permission = withPermission(query);
    await expect(permission?.("local")).resolves.toBe("denied");
    expect(query.mock.calls.map(([descriptor]) => descriptor.name)).toEqual([
      "local-network",
      "local-network-access",
    ]);
  });

  it("reports unsupported where no LNA name is known", async () => {
    const permission = withPermission(async () => {
      throw new Error("unknown");
    });
    await expect(permission?.("loopback")).resolves.toBe("unsupported");
  });
});
