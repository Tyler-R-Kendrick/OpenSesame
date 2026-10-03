/**
 * A session follows the pairing, not just the daemon's host: a re-pair on the
 * same host reads again, an answer for an older pairing is never drawn, and a
 * switch is bound to the pairing it was issued for.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { pluginById } from "./catalog.js";
import type {
  PluginDaemon,
  PluginDaemonRequest,
  PluginDaemonTarget,
} from "./client.js";
import { createPluginSession } from "./session.js";

const json = (body: BoundaryValue, status = 200) =>
  new Response(JSON.stringify(body), { status });

const state = (enabled: boolean) => ({
  id: "surrogate-proxy",
  capability: "agents.surrogate-credentials",
  installed: true,
  version: "0.1.0",
  enabled,
  forced_off: false,
  active: enabled,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const at = (host: string, revision: number): PluginDaemonTarget => ({
  label: host,
  host,
  revision,
});

type Held = {
  path: string;
  /** The pairing this request was issued under, as the port resolved it. */
  sentTo: PluginDaemonTarget | null;
  init: PluginDaemonRequest;
  answer: (response: Response) => void;
};

/** A port whose answers the test releases by hand, and whose pairing it moves. */
function heldDaemon(initial: PluginDaemonTarget | null, notify = true) {
  let target = initial;
  const listeners = new Set<() => void>();
  const held: Held[] = [];
  const port: PluginDaemon = {
    target: () => target,
    request: (path, init) =>
      new Promise<Response>((resolve) => {
        held.push({ path, sentTo: target, init, answer: resolve });
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    held,
    move(next: PluginDaemonTarget | null) {
      target = next;
      if (notify) for (const listener of listeners) listener();
    },
    pending: (path: string) => held.filter((entry) => entry.path === path),
  };
}

const session = (port: PluginDaemon) =>
  createPluginSession(pluginById("surrogate-proxy"), port);

describe("a session across pairings of the same daemon", () => {
  it("reads again after a re-pair on the same host, and clears 'unauthorized'", async () => {
    const daemon = heldDaemon(at("desk.tail.ts.net", 1));
    const open = session(daemon.port);
    open.ensure();
    daemon.held[0]?.answer(json({ error: "operator_unauthorized" }, 401));
    await settle();
    expect(open.view().error).toBe("unauthorized");
    daemon.move(at("desk.tail.ts.net", 2));
    await settle();
    expect(open.view()).toMatchObject({ busy: true, error: null });
    daemon.held[1]?.answer(json({ plugins: [state(false)] }));
    await settle();
    daemon.held[2]?.answer(json({ notices: [] }));
    await settle();
    expect(open.view().error).toBeNull();
    expect(open.view().state?.enabled).toBe(false);
    expect(open.view().daemon?.revision).toBe(2);
  });

  it("does not read again when nothing about the pairing moved", async () => {
    const daemon = heldDaemon(at("desk.tail.ts.net", 1));
    const open = session(daemon.port);
    open.ensure();
    open.ensure();
    expect(daemon.held).toHaveLength(1);
    daemon.move(at("desk.tail.ts.net", 1));
    expect(daemon.held).toHaveLength(1);
  });

  it("drops an old read that answers after a re-pair", async () => {
    const daemon = heldDaemon(at("desk.tail.ts.net", 1));
    const open = session(daemon.port);
    open.ensure();
    daemon.move(at("desk.tail.ts.net", 2));
    const [older, newer] = daemon.held;
    newer?.answer(json({ plugins: [state(false)] }));
    await settle();
    daemon.held[2]?.answer(json({ notices: [] }));
    await settle();
    expect(open.view().state?.enabled).toBe(false);
    // The old pairing's answer, late, neither replaces the view nor errors it.
    older?.answer(json({ plugins: [state(true)] }));
    await settle();
    expect(open.view().state?.enabled).toBe(false);
    expect(open.view().daemon?.revision).toBe(2);
    expect(daemon.held).toHaveLength(3);
  });

  it("drops an old refusal that arrives after a re-pair", async () => {
    const daemon = heldDaemon(at("desk.tail.ts.net", 1));
    const open = session(daemon.port);
    open.ensure();
    daemon.move(at("desk.tail.ts.net", 2));
    const [older, newer] = daemon.held;
    newer?.answer(json({ plugins: [state(false)] }));
    await settle();
    daemon.held[2]?.answer(json({ notices: [] }));
    await settle();
    older?.answer(json({ error: "operator_unauthorized" }, 401));
    await settle();
    expect(open.view().error).toBeNull();
    expect(open.view().state?.enabled).toBe(false);
  });
});

async function loadedOn(daemon: ReturnType<typeof heldDaemon>) {
  const open = session(daemon.port);
  open.ensure();
  daemon.held[0]?.answer(json({ plugins: [state(true)] }));
  await settle();
  daemon.held[1]?.answer(json({ notices: [] }));
  await settle();
  expect(open.view().state?.enabled).toBe(true);
  return open;
}

describe("a switch is bound to the pairing it was issued for", () => {
  it("discards the answer of a switch whose target moved while it was out", async () => {
    const daemon = heldDaemon(at("desk.tail.ts.net", 1));
    const open = await loadedOn(daemon);
    const switched = open.toggle();
    expect(daemon.pending("/v1/plugins/surrogate-proxy")).toHaveLength(1);
    daemon.move(at("lab.tail.ts.net", 2));
    // The new target is read; its answer is what the view shows.
    daemon.pending("/v1/plugins")[1]?.answer(json({ plugins: [state(true)] }));
    await settle();
    daemon
      .pending("/v1/plugins/surrogate-proxy/notices")[1]
      ?.answer(json({ notices: [] }));
    await settle();
    const put = daemon.pending("/v1/plugins/surrogate-proxy")[0];
    put?.answer(json(state(false)));
    await switched;
    await settle();
    expect(open.view().daemon?.host).toBe("lab.tail.ts.net");
    expect(open.view().state?.enabled).toBe(true);
    expect(open.view().busy).toBe(false);
    expect(open.view().error).toBeNull();
  });

  it("refuses a switch after the target changed, and sends nothing to the new daemon", async () => {
    // A port whose listeners were not told: the view still holds the old state.
    const daemon = heldDaemon(at("desk.tail.ts.net", 1), false);
    const open = await loadedOn(daemon);
    const before = daemon.held.length;
    daemon.move(at("lab.tail.ts.net", 2));
    await open.toggle();
    const sent = daemon.held.slice(before).map((entry) => entry.path);
    expect(sent).not.toContain("/v1/plugins/surrogate-proxy");
    for (const entry of daemon.held.slice(before))
      expect(entry.init.method).toBe("GET");
  });

  it("reads the new target after refusing, instead of drawing the old state", async () => {
    const daemon = heldDaemon(at("desk.tail.ts.net", 1), false);
    const open = await loadedOn(daemon);
    const before = daemon.held.length;
    daemon.move(at("desk.tail.ts.net", 2));
    await open.toggle();
    expect(daemon.held.length).toBeGreaterThan(before);
    daemon.held[before]?.answer(json({ plugins: [state(false)] }));
    await settle();
    daemon.held[before + 1]?.answer(json({ notices: [] }));
    await settle();
    expect(open.view().state?.enabled).toBe(false);
    expect(open.view().daemon?.revision).toBe(2);
    expect(open.view().busy).toBe(false);
  });

  it("tells the port which pairing each request was issued for", async () => {
    const daemon = heldDaemon(at("desk.tail.ts.net", 7));
    const open = await loadedOn(daemon);
    void open.toggle();
    const put = daemon.pending("/v1/plugins/surrogate-proxy")[0];
    expect(put?.init.expect).toEqual(at("desk.tail.ts.net", 7));
    expect(daemon.held[0]?.init.expect).toEqual(at("desk.tail.ts.net", 7));
  });
});
