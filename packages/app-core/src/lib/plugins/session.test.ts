import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { pluginById } from "./catalog.js";
import type { PluginDaemon, PluginDaemonTarget } from "./client.js";
import { createPluginSession } from "./session.js";

const json = (body: BoundaryValue, status = 200) =>
  new Response(JSON.stringify(body), { status });

const ON = {
  id: "surrogate-proxy",
  capability: "agents.surrogate-credentials",
  installed: true,
  version: "0.1.0",
  enabled: true,
  forced_off: false,
  active: true,
};

function fakeDaemon(initial: PluginDaemonTarget | null) {
  let target = initial;
  const listeners = new Set<() => void>();
  const paths: string[] = [];
  let answer = (path: string): Response =>
    path.endsWith("/notices")
      ? json({ notices: [] })
      : path === "/v1/plugins"
        ? json({ plugins: [ON] })
        : json({ ...ON, enabled: false, active: false });
  const port: PluginDaemon = {
    target: () => target,
    request: async (path, init) => {
      paths.push(`${init.method} ${path}`);
      return answer(path);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    paths,
    listeners,
    move(next: PluginDaemonTarget | null) {
      target = next;
      for (const listener of listeners) listener();
    },
    answerWith(next: (path: string) => Response) {
      answer = next;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const DESK = { label: "desk", host: "desk.tail.ts.net" };

describe("a plugin session", () => {
  it("sends nothing until asked, and nothing with no daemon paired", async () => {
    const daemon = fakeDaemon(null);
    const session = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    expect(daemon.paths).toEqual([]);
    session.ensure();
    await settle();
    expect(daemon.paths).toEqual([]);
    expect(session.view().daemon).toBeNull();
  });

  it("reads state and tripwires once per daemon, and again when the pairing moves", async () => {
    const daemon = fakeDaemon(DESK);
    const session = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    session.ensure();
    session.ensure();
    await settle();
    expect(daemon.paths).toEqual([
      "GET /v1/plugins",
      "GET /v1/plugins/surrogate-proxy/notices",
    ]);
    expect(session.view().state?.active).toBe(true);
    daemon.move({ label: "lab", host: "lab.tail.ts.net" });
    await settle();
    expect(daemon.paths).toHaveLength(4);
    daemon.move(null);
    expect(session.view()).toMatchObject({ daemon: null, state: null });
  });

  it("switches through the daemon and draws what it answered", async () => {
    const daemon = fakeDaemon(DESK);
    const session = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    session.ensure();
    await settle();
    await session.toggle();
    expect(daemon.paths.at(-1)).toBe("PUT /v1/plugins/surrogate-proxy");
    expect(session.view().state?.enabled).toBe(false);
    expect(session.view().error).toBeNull();
  });

  it("keeps the standing it had when the switch is refused, and says why", async () => {
    const daemon = fakeDaemon(DESK);
    const session = createPluginSession(
      pluginById("surrogate-proxy"),
      daemon.port,
    );
    session.ensure();
    await settle();
    daemon.answerWith(() => json({ error: "operator_unauthorized" }, 401));
    await session.toggle();
    expect(session.view().state?.enabled).toBe(true);
    expect(session.view().error).toBe("unauthorized");
  });

  it("dispose aborts what is in flight, stops listening and sends nothing", async () => {
    const daemon = fakeDaemon(DESK);
    let aborted = false;
    const port: PluginDaemon = {
      ...daemon.port,
      request: (path, init) => {
        daemon.paths.push(path);
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    };
    const session = createPluginSession(pluginById("surrogate-proxy"), port);
    const seen = vi.fn();
    session.subscribe(seen);
    session.ensure();
    seen.mockClear();
    session.dispose();
    await settle();
    expect(aborted).toBe(true);
    expect(daemon.listeners.size).toBe(0);
    expect(seen).not.toHaveBeenCalled();
    expect(daemon.paths).toEqual(["/v1/plugins"]);
  });

  it("gives up on a daemon that never answers", async () => {
    vi.useFakeTimers();
    try {
      const daemon = fakeDaemon(DESK);
      const port: PluginDaemon = {
        ...daemon.port,
        request: (_path, init) =>
          new Promise((_, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      };
      const session = createPluginSession(pluginById("surrogate-proxy"), port);
      session.ensure();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(session.view().error).toBe("unreachable");
      expect(session.view().busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
