/**
 * A re-pair supersedes what the old pairing had in flight: those reads and
 * switches are aborted, not left to run to the end and be discarded.
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

const json = (body: BoundaryValue) =>
  new Response(JSON.stringify(body), { status: 200 });
const state = {
  id: "surrogate-proxy",
  capability: "agents.surrogate-credentials",
  installed: true,
  version: "0.1.0",
  enabled: false,
  forced_off: false,
  active: false,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const at = (revision: number): PluginDaemonTarget => ({
  label: "desk",
  host: "desk.tail.ts.net",
  revision,
});

function daemonAt(initial: PluginDaemonTarget) {
  let target = initial;
  const listeners = new Set<() => void>();
  const held: Array<{
    path: string;
    init: PluginDaemonRequest;
    answer: (response: Response) => void;
  }> = [];
  const port: PluginDaemon = {
    target: () => target,
    request: (path, init) =>
      new Promise<Response>((resolve, reject) => {
        held.push({ path, init, answer: resolve });
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    held,
    move(next: PluginDaemonTarget) {
      target = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("superseded requests", () => {
  it("aborts a read the pairing outlived, and not the read that replaced it", async () => {
    const daemon = daemonAt(at(1));
    const open = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    open.ensure();
    expect(daemon.held[0]?.init.signal.aborted).toBe(false);
    daemon.move(at(2));
    await settle();
    expect(daemon.held[0]?.init.signal.aborted).toBe(true);
    expect(daemon.held[1]?.init.signal.aborted).toBe(false);
    open.dispose();
    expect(daemon.held[1]?.init.signal.aborted).toBe(true);
  });

  it("aborts a switch the pairing outlived", async () => {
    const daemon = daemonAt(at(1));
    const open = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    open.ensure();
    daemon.held[0]?.answer(json({ plugins: [state] }));
    await settle();
    daemon.held[1]?.answer(json({ notices: [] }));
    await settle();
    const toggling = open.toggle();
    await settle();
    const put = daemon.held.find((entry) => entry.init.method === "PUT");
    expect(put?.init.signal.aborted).toBe(false);
    daemon.move(at(2));
    await toggling;
    expect(put?.init.signal.aborted).toBe(true);
  });

  it("leaves a pairing call to finish when the pairing it caused moves", async () => {
    const daemon = daemonAt(at(1));
    const seen: AbortSignal[] = [];
    const port: PluginDaemon = {
      ...daemon.port,
      pair: (_code, signal) =>
        new Promise<void>((resolve) => {
          seen.push(signal);
          daemon.move(at(2));
          resolve();
        }),
    };
    const open = createPluginSession(pluginById("surrogate-proxy"), port);
    await open.pair("code");
    expect(seen.map((signal) => signal.aborted)).toEqual([false]);
  });
});
