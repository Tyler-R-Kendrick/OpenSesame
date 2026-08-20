import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Telemetry, createTelemetry } from "@opensesame/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JsonObject, overlapCast, type BoundaryValue } from "@opensesame/os-domain";
import { posthogSeams } from "./posthog.js";
import { wrapServerWithTelemetry } from "./telemetry.js";

type AnyFn = (...args: unknown[]) => BoundaryValue;

class FakePostHog {
  static failShutdown = false;
  captures: Array<JsonObject> = [];
  shutdowns = 0;
  constructor(
    public key: string,
    public options: { host: string },
  ) {
    instances.push(this);
  }
  capture(event: JsonObject) {
    this.captures.push(event);
  }
  async shutdown() {
    this.shutdowns += 1;
    if (FakePostHog.failShutdown) {
      throw new Error("flush failed");
    }
  }
}

const instances: FakePostHog[] = [];

function makeFakeServer(clientInfo?: { name: string; version: string }) {
  const registered = new Map<string, AnyFn>();
  const fake = {
    tool: (...args: unknown[]) => {
      registered.set(overlapCast(args[0]), overlapCast(args[args.length - 1]));
      return { name: args[0] };
    },
    server: {
      getClientVersion: () => clientInfo,
    },
  };
  return { server: overlapCast(fake), registered };
}

function toolFnOf(server: McpServer): AnyFn {
  return (overlapCast(server)).tool;
}

const ENV_KEYS = [
  "OPENSESAME_TELEMETRY_KEY",
  "OPENSESAME_TELEMETRY_HOST",
] as const;

describe("wrapServerWithTelemetry env-driven path", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    FakePostHog.failShutdown = false;
    posthogSeams.PostHog = overlapCast(FakePostHog);
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
    FakePostHog.failShutdown = false;
  });

  it("builds one cached PostHog client from the env key and captures through it", async () => {
    process.env.OPENSESAME_TELEMETRY_KEY = "phc_test";
    // biome-ignore lint/performance/noDelete: default host branch needs the var unset
    delete process.env.OPENSESAME_TELEMETRY_HOST;
    const before = instances.length;

    const { server, registered } = makeFakeServer({
      name: "claude-code",
      version: "1.0.0",
    });
    wrapServerWithTelemetry(server);
    toolFnOf(server)("host_ready", "desc", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await registered.get("host_ready")?.();

    const second = makeFakeServer();
    wrapServerWithTelemetry(second.server);

    expect(instances.length).toBe(before + 1);
    const client = instances[before];
    expect(client?.key).toBe("phc_test");
    expect(client?.options.host).toBe("https://us.i.posthog.com");

    expect(client?.captures).toHaveLength(1);
    const event = client?.captures[0];
    expect(event?.event).toBe("mcp_tool_call");
    expect(event?.distinctId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(event?.properties).toMatchObject({
      tool: "host_ready",
      outcome: "ok",
      client: "claude-code",
    });
  });

  it("honors OPENSESAME_TELEMETRY_HOST for a fresh process", async () => {
    vi.resetModules();
    const { posthogSeams: seams } = await import("./posthog.js");
    seams.PostHog = overlapCast(FakePostHog);
    const { wrapServerWithTelemetry: freshWrap } = await import(
      "./telemetry.js"
    );
    process.env.OPENSESAME_TELEMETRY_KEY = "phc_test";
    process.env.OPENSESAME_TELEMETRY_HOST = "https://eu.i.posthog.com";
    const before = instances.length;

    const { server } = makeFakeServer();
    freshWrap(server);

    expect(instances.length).toBe(before + 1);
    expect(instances[before]?.options.host).toBe("https://eu.i.posthog.com");
  });

  it("flushes on SIGINT/SIGTERM and swallows a failed flush", async () => {
    vi.resetModules();
    const { posthogSeams: seams } = await import("./posthog.js");
    seams.PostHog = overlapCast(FakePostHog);
    const { wrapServerWithTelemetry: freshWrap } = await import(
      "./telemetry.js"
    );
    process.env.OPENSESAME_TELEMETRY_KEY = "phc_test";
    const before = instances.length;

    const { server } = makeFakeServer();
    freshWrap(server);
    const client = instances[before];

    const shutdowns = client?.shutdowns ?? 0;
    process.emit("SIGINT");
    process.emit("SIGTERM");
    expect(client?.shutdowns).toBe(shutdowns + 2);

    FakePostHog.failShutdown = true;
    process.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    expect(client?.shutdowns).toBe(shutdowns + 3);
  });

  it("falls through untouched when the last tool() argument is not a callback", () => {
    // biome-ignore lint/performance/noDelete: explicit telemetry, no env key needed
    delete process.env.OPENSESAME_TELEMETRY_KEY;
    const events: Array<{ event: string; props: JsonObject }> = [];
    const telemetry: Telemetry = createTelemetry({
      capture: (event, props) => events.push({ event, props }),
    });
    const { server, registered } = makeFakeServer();
    wrapServerWithTelemetry(server, telemetry);

    toolFnOf(server)("weird", "desc-only");
    expect(registered.get("weird")).toBe("desc-only");
    expect(events).toHaveLength(0);
  });
});
