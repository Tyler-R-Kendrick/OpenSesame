import { describe, expect, it, vi } from "vitest";
import { type PluginDaemon, PluginError } from "./client.js";
import { pinnedTo, sameTarget } from "./pinned.js";

const at = (host: string, revision: number) => ({
  label: host,
  host,
  revision,
});
const signal = new AbortController().signal;

describe("the pairing a call is bound to", () => {
  it("is the same only for the same host and the same revision", () => {
    expect(sameTarget(at("a", 1), at("a", 1))).toBe(true);
    expect(sameTarget(at("a", 1), at("a", 2))).toBe(false);
    expect(sameTarget(at("a", 1), at("b", 1))).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(null, undefined)).toBe(true);
    expect(sameTarget(at("a", 1), null)).toBe(false);
    expect(sameTarget(undefined, at("a", 1))).toBe(false);
  });

  it("hands a call on, naming its pairing, only while that pairing holds", async () => {
    let now: ReturnType<typeof at> | null = at("a", 1);
    const request = vi.fn(async () => new Response("{}"));
    const port: PluginDaemon = { target: () => now, request };
    const pinned = pinnedTo(port, at("a", 1));
    await pinned.request("/x", { method: "GET", signal });
    expect(request).toHaveBeenCalledWith("/x", {
      method: "GET",
      signal,
      expect: at("a", 1),
    });
    for (const moved of [at("a", 2), at("b", 1), null]) {
      now = moved;
      await expect(
        pinned.request("/x", { method: "PUT", signal }),
      ).rejects.toBeInstanceOf(PluginError);
    }
    expect(request).toHaveBeenCalledTimes(1);
  });
});
