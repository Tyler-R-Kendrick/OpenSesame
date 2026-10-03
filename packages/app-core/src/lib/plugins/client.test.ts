import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  type PluginDaemon,
  type PluginDaemonRequest,
  PluginError,
  readPluginNotices,
  readPluginStates,
  setPluginEnabled,
} from "./client.js";
import type { PluginState } from "./wire.js";

type Sent = { path: string; init: PluginDaemonRequest };

function daemon(answer: (sent: Sent) => Response, paired = true) {
  const sent: Sent[] = [];
  const port: PluginDaemon = {
    target: () => (paired ? { label: "desk", host: "desk.tail.ts.net" } : null),
    request: async (path, init) => {
      const call = { path, init };
      sent.push(call);
      return answer(call);
    },
  };
  return { port, sent };
}

const json = (body: BoundaryValue, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const signal = new AbortController().signal;

const INSTALLED_OFF: PluginState = {
  id: "surrogate-proxy",
  installed: true,
  version: "0.1.0",
  enabled: false,
  forcedOff: false,
  active: false,
};

const wire = (state: PluginState) => ({
  id: state.id,
  capability:
    state.id === "surrogate-proxy"
      ? "agents.surrogate-credentials"
      : "vault.browser-autofill",
  installed: state.installed,
  version: state.version,
  enabled: state.enabled,
  forced_off: state.forcedOff,
  active: state.active,
});

async function refusedWith<T>(work: Promise<T>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof PluginError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("switching a plugin from the page", () => {
  it("cannot turn on a plugin the daemon's environment forces off: nothing is sent", async () => {
    const { port, sent } = daemon(() => json({}));
    const forced = { ...INSTALLED_OFF, forcedOff: true };
    expect(
      await refusedWith(setPluginEnabled(port, forced, true, signal)),
    ).toBe("forced-off");
    expect(sent).toEqual([]);
  });

  it("cannot switch a plugin that is not installed: nothing is sent, nothing installs", async () => {
    const { port, sent } = daemon(() => json({}));
    const missing = { ...INSTALLED_OFF, installed: false };
    expect(
      await refusedWith(setPluginEnabled(port, missing, true, signal)),
    ).toBe("not-installed");
    expect(sent).toEqual([]);
  });

  it("refuses an answer about another plugin", async () => {
    const { port } = daemon(() =>
      json(wire({ ...INSTALLED_OFF, id: "browser-autofill", enabled: true })),
    );
    expect(
      await refusedWith(setPluginEnabled(port, INSTALLED_OFF, true, signal)),
    ).toBe("malformed");
  });

  it("sends exactly {enabled} to the plugin's own route and reads the answer", async () => {
    const on = { ...INSTALLED_OFF, enabled: true, active: true };
    const { port, sent } = daemon(() => json(wire(on)));
    expect(await setPluginEnabled(port, INSTALLED_OFF, true, signal)).toEqual(
      on,
    );
    expect(
      sent.map((call) => [call.path, call.init.method, call.init.body]),
    ).toEqual([["/v1/plugins/surrogate-proxy", "PUT", '{"enabled":true}']]);
  });

  it("may still turn off a plugin the environment forces off", async () => {
    const forcedOn = { ...INSTALLED_OFF, enabled: true, forcedOff: true };
    const { port, sent } = daemon(() =>
      json(wire({ ...forcedOn, enabled: false })),
    );
    await setPluginEnabled(port, forcedOn, false, signal);
    expect(sent).toHaveLength(1);
  });

  it("names the daemon's refusals", async () => {
    const cases: [Response, string][] = [
      [json({ error: "not_installed" }, 404), "not-installed"],
      [json({ error: "unknown_plugin" }, 400), "unknown-plugin"],
      [json({ error: "pin_mismatch" }, 409), "pin-mismatch"],
      [json({ error: "operator_unauthorized" }, 401), "unauthorized"],
      [json({}, 403), "unauthorized"],
      [json({ error: "operator_token_unconfigured" }, 503), "refused"],
    ];
    for (const [response, code] of cases) {
      const { port } = daemon(() => response);
      expect(
        await refusedWith(setPluginEnabled(port, INSTALLED_OFF, true, signal)),
      ).toBe(code);
    }
  });
});

describe("reading plugins", () => {
  it("sends nothing when no daemon is paired", async () => {
    const { port, sent } = daemon(() => json({ plugins: [] }), false);
    expect(await refusedWith(readPluginStates(port, signal))).toBe("no-daemon");
    expect(sent).toEqual([]);
  });

  it("says unreachable, not the transport's words, when the request fails", async () => {
    const port: PluginDaemon = {
      target: () => ({ label: "", host: "desk" }),
      request: async () => {
        throw new TypeError("Failed to fetch http://desk/?key=secret");
      },
    };
    expect(await refusedWith(readPluginStates(port, signal))).toBe(
      "unreachable",
    );
  });

  it("refuses a body larger than the routes ever send", async () => {
    const huge = "x".repeat(70 * 1024);
    const { port } = daemon(() => json({ plugins: [], pad: huge }));
    expect(await refusedWith(readPluginStates(port, signal))).toBe("malformed");
  });

  it("reads the list and the tripwires from their own routes", async () => {
    const { port, sent } = daemon((call) =>
      call.path === "/v1/plugins"
        ? json({ plugins: [wire(INSTALLED_OFF)] })
        : json({
            notices: [
              {
                event_type: "surrogate.wrong_host",
                severity: "high",
                occurred_at: "2026-09-28T10:00:00Z",
                summary: "x",
              },
            ],
          }),
    );
    expect(await readPluginStates(port, signal)).toEqual([INSTALLED_OFF]);
    expect(await readPluginNotices(port, "surrogate-proxy", signal)).toEqual([
      {
        event: "surrogate.wrong_host",
        at: "2026-09-28T10:00:00.000Z",
        subject: null,
      },
    ]);
    expect(sent.map((call) => call.path)).toEqual([
      "/v1/plugins",
      "/v1/plugins/surrogate-proxy/notices",
    ]);
  });

  it("asks for no tripwires for a plugin that keeps none", async () => {
    const { port, sent } = daemon(() => json({ notices: [] }));
    expect(await readPluginNotices(port, "browser-autofill", signal)).toEqual(
      [],
    );
    expect(sent).toEqual([]);
  });
});
