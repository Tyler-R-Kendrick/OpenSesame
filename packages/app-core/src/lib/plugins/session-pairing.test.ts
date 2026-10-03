/**
 * A session over a port that can pair: the pasted code goes to the port
 * once, a refusal lands in the view's error with no daemon drawn, and a
 * pairing that took reads the plugin at once.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { pluginById } from "./catalog.js";
import { type PluginDaemon, PluginError } from "./client.js";
import { createPluginSession } from "./session.js";

const json = (body: BoundaryValue, status = 200) =>
  new Response(JSON.stringify(body), { status });

const INSTALLED = {
  id: "surrogate-proxy",
  capability: "agents.surrogate-credentials",
  installed: true,
  version: "0.1.0",
  enabled: false,
  forced_off: false,
  active: false,
};
const DESK = { label: "Desk", host: "desk.tail4c2e.ts.net", revision: 1 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function pairingDaemon(open = true) {
  let paired = false;
  const listeners = new Set<() => void>();
  const told = () => {
    for (const listener of listeners) listener();
  };
  const pair = vi.fn(async (code: string) => {
    if (code !== "good") throw new PluginError("pairing-refused");
    paired = true;
    told();
  });
  const forget = vi.fn(async () => {
    paired = false;
    told();
  });
  const port: PluginDaemon = {
    target: () => (paired ? DESK : null),
    request: async (path) =>
      path === "/v1/plugins"
        ? json({ plugins: [INSTALLED] })
        : json({ notices: [] }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canPair: () => open,
    pair,
    forget,
  };
  return { port, pair, forget };
}

describe("pairing through a plugin session", () => {
  it("draws the daemon and reads the plugin once a code is taken", async () => {
    const daemon = pairingDaemon();
    const session = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    session.ensure();
    expect(session.pairable).toBe(true);
    expect(session.canPair()).toBe(true);
    await session.pair("good");
    await settle();
    expect(daemon.pair).toHaveBeenCalledTimes(1);
    expect(session.view().daemon).toEqual(DESK);
    expect(session.view().state?.installed).toBe(true);
    expect(session.view().error).toBeNull();
  });

  it("keeps no daemon and names the refusal when a code is not taken", async () => {
    const daemon = pairingDaemon();
    const session = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    session.ensure();
    await session.pair("spent");
    expect(session.view().daemon).toBeNull();
    expect(session.view().error).toBe("pairing-refused");
    expect(session.view().busy).toBe(false);
  });

  it("forgets back to no daemon", async () => {
    const daemon = pairingDaemon();
    const session = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    session.ensure();
    await session.pair("good");
    await session.forget();
    await settle();
    expect(daemon.forget).toHaveBeenCalledTimes(1);
    expect(session.view().daemon).toBeNull();
    expect(session.view().state).toBeNull();
  });

  it("offers nothing over a port that cannot pair, and sends nothing after dispose", async () => {
    const bare: PluginDaemon = {
      target: () => null,
      request: async () => json({}),
    };
    const session = createPluginSession(pluginById("surrogate-proxy"), bare);
    expect(session.pairable).toBe(false);
    expect(session.canPair()).toBe(false);
    await session.pair("good");
    expect(session.view().error).toBeNull();
    const daemon = pairingDaemon();
    const closed = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    closed.dispose();
    await closed.pair("good");
    expect(daemon.pair).not.toHaveBeenCalled();
  });
});
