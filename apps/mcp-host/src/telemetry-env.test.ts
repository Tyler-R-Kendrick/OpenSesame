import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Telemetry, createTelemetry } from "@opensesame/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AnyFn = (...args: unknown[]) => unknown;

/**
 * The env-driven path of telemetry.ts (OPENSESAME_TELEMETRY_KEY set) builds a
 * real PostHog client, caches it process-wide, and hooks SIGINT/SIGTERM to
 * flush. PostHog is mocked so no network happens; everything else — client
 * caching, capture plumbing, the shutdown hook — is the real code.
 */
const mocks = vi.hoisted(() => {
  class FakePostHog {
    static failShutdown = false;
    captures: Array<Record<string, unknown>> = [];
    shutdowns = 0;
    constructor(
      public key: string,
      public options: { host: string },
    ) {}
    capture(event: Record<string, unknown>) {
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
  return { FakePostHog, instances };
});

vi.mock("posthog-node", () => ({
  PostHog: class extends mocks.FakePostHog {
    constructor(...args: [string, { host: string }]) {
      super(...args);
      mocks.instances.push(this);
    }
  },
}));

import { wrapServerWithTelemetry } from "./telemetry.js";

function makeFakeServer(clientInfo?: { name: string; version: string }) {
  const registered = new Map<string, AnyFn>();
  const fake = {
    tool: (...args: unknown[]) => {
      registered.set(args[0] as string, args[args.length - 1] as AnyFn);
      return { name: args[0] };
    },
    server: {
      getClientVersion: () => clientInfo,
    },
  };
  return { server: fake as unknown as McpServer, registered };
}

function toolFnOf(server: McpServer): AnyFn {
  return (server as unknown as { tool: AnyFn }).tool;
}

const ENV_KEYS = [
  "OPENSESAME_TELEMETRY_KEY",
  "OPENSESAME_TELEMETRY_HOST",
] as const;

describe("wrapServerWithTelemetry env-driven path", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    mocks.FakePostHog.failShutdown = false;
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
    mocks.FakePostHog.failShutdown = false;
  });

  it("builds one cached PostHog client from the env key and captures through it", async () => {
    process.env.OPENSESAME_TELEMETRY_KEY = "phc_test";
    // biome-ignore lint/performance/noDelete: default host branch needs the var unset
    delete process.env.OPENSESAME_TELEMETRY_HOST;
    const before = mocks.instances.length;

    const { server, registered } = makeFakeServer({
      name: "claude-code",
      version: "1.0.0",
    });
    wrapServerWithTelemetry(server);
    toolFnOf(server)("host_ready", "desc", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await registered.get("host_ready")?.();

    // A second server reuses the same process-wide client.
    const second = makeFakeServer();
    wrapServerWithTelemetry(second.server);

    expect(mocks.instances.length).toBe(before + 1);
    const client = mocks.instances[before];
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
    const { wrapServerWithTelemetry: freshWrap } = await import(
      "./telemetry.js"
    );
    process.env.OPENSESAME_TELEMETRY_KEY = "phc_test";
    process.env.OPENSESAME_TELEMETRY_HOST = "https://eu.i.posthog.com";
    const before = mocks.instances.length;

    const { server } = makeFakeServer();
    freshWrap(server);

    expect(mocks.instances.length).toBe(before + 1);
    expect(mocks.instances[before]?.options.host).toBe(
      "https://eu.i.posthog.com",
    );
  });

  it("flushes on SIGINT/SIGTERM and swallows a failed flush", async () => {
    vi.resetModules();
    const { wrapServerWithTelemetry: freshWrap } = await import(
      "./telemetry.js"
    );
    process.env.OPENSESAME_TELEMETRY_KEY = "phc_test";
    const before = mocks.instances.length;

    const { server } = makeFakeServer();
    freshWrap(server);
    const client = mocks.instances[before];

    const shutdowns = client?.shutdowns ?? 0;
    process.emit("SIGINT");
    process.emit("SIGTERM");
    expect(client?.shutdowns).toBe(shutdowns + 2);

    // A rejected shutdown must not escape the signal handler.
    mocks.FakePostHog.failShutdown = true;
    process.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    expect(client?.shutdowns).toBe(shutdowns + 3);
  });

  it("falls through untouched when the last tool() argument is not a callback", () => {
    // biome-ignore lint/performance/noDelete: explicit telemetry, no env key needed
    delete process.env.OPENSESAME_TELEMETRY_KEY;
    const events: Array<{ event: string; props: Record<string, unknown> }> = [];
    const telemetry: Telemetry = createTelemetry({
      capture: (event, props) => events.push({ event, props }),
    });
    const { server, registered } = makeFakeServer();
    wrapServerWithTelemetry(server, telemetry);

    // A shape the wrapper does not recognize passes through to the original
    // registrar unmodified and emits nothing.
    toolFnOf(server)("weird", "desc-only");
    expect(registered.get("weird")).toBe("desc-only");
    expect(events).toHaveLength(0);
  });
});
