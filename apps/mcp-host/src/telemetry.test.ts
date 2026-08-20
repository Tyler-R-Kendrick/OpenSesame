import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Telemetry, createTelemetry } from "@opensesame/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapServerWithTelemetry } from "./telemetry.js";
import { type JsonObject, overlapCast, type BoundaryValue } from "@opensesame/os-domain";

type AnyFn = (...args: unknown[]) => BoundaryValue;

/**
 * A minimal fake standing in for `McpServer`: just enough surface
 * (`.tool()` that records its last-arg callback, and `.server.getClientVersion()`)
 * for `wrapServerWithTelemetry` to operate on, without needing the real MCP
 * protocol machinery (whose registered handlers aren't directly invokable
 * outside a live client/server exchange — see tools.test.ts's own note on
 * this).
 */
function makeFakeServer(clientInfo?: { name: string; version: string }) {
  const registered = new Map<string, AnyFn>();
  const fake = {
    tool: (...args: unknown[]) => {
      const name = overlapCast(args[0]);
      const handler = overlapCast(args[args.length - 1]);
      registered.set(name, handler);
      return { name };
    },
    server: {
      getClientVersion: () => clientInfo,
    },
  };
  return { server: overlapCast(fake), registered };
}

/** Cast through the fake's own shape to call `.tool()` with arbitrary args
 * without fighting the real SDK's six overloaded call signatures — the fake
 * server ignores everything but "first arg is the name, last arg is the
 * callback" anyway. */
function toolFnOf(server: McpServer): AnyFn {
  return (overlapCast(server)).tool;
}

function capturingTelemetry() {
  const events: Array<{ event: string; props: JsonObject }> = [];
  const telemetry: Telemetry = createTelemetry({
    capture: (event, props) => events.push({ event, props }),
  });
  return { telemetry, events };
}

describe("wrapServerWithTelemetry", () => {
  const savedKey = process.env.OPENSESAME_TELEMETRY_KEY;

  beforeEach(() => {
    // `= undefined` would stringify to "undefined" (process.env coerces all
    // values to strings), which is truthy and would defeat the unset checks
    // this suite relies on — an actual delete is required, matching the same
    // pattern already used throughout apps/mcp-host/src/tools.test.ts.
    // biome-ignore lint/performance/noDelete: see comment above
    delete process.env.OPENSESAME_TELEMETRY_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) {
      // biome-ignore lint/performance/noDelete: see beforeEach above
      delete process.env.OPENSESAME_TELEMETRY_KEY;
    } else {
      process.env.OPENSESAME_TELEMETRY_KEY = savedKey;
    }
  });

  it("does not touch tool registration when no telemetry is configured", () => {
    const { server } = makeFakeServer();
    const originalTool = toolFnOf(server);
    wrapServerWithTelemetry(server); // no explicit telemetry, no env key
    expect(toolFnOf(server)).toBe(originalTool);
  });

  it("emits mcp_tool_call with exactly tool/duration_ms/outcome/client on success", async () => {
    const { server, registered } = makeFakeServer({
      name: "claude-code",
      version: "9.9.9",
    });
    const { telemetry, events } = capturingTelemetry();
    wrapServerWithTelemetry(server, telemetry);

    toolFnOf(server)("task_start", "desc", {}, async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_run_id: "t1",
            secret: "should-not-leak",
          }),
        },
      ],
      isError: false,
    }));

    const handler = registered.get("task_start");
    expect(handler).toBeDefined();
    const result = overlapCast(await handler?.({
      principal_id: "top-secret-principal",
    }));

    // The real tool response is unaffected by wrapping.
    expect(result.content[0]?.text).toContain("should-not-leak");

    expect(events).toHaveLength(1);
    const props = events[0]?.props ?? {};
    expect(events[0]?.event).toBe("mcp_tool_call");
    expect(props).toEqual({
      tool: "task_start",
      duration_ms: expect.any(Number),
      outcome: "ok",
      client: "claude-code",
    });

    // Arguments and results never leak into the captured payload.
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain("top-secret-principal");
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("task_run_id");
  });

  it("falls back to client: 'unknown' before the MCP handshake completes", async () => {
    const { server, registered } = makeFakeServer(undefined);
    const { telemetry, events } = capturingTelemetry();
    wrapServerWithTelemetry(server, telemetry);

    toolFnOf(server)("host_ready", "desc", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    await registered.get("host_ready")?.();
    expect(events[0]?.props.client).toBe("unknown");
  });

  it("classifies a thrown error as outcome: error with error_class only (never the message)", async () => {
    const { server, registered } = makeFakeServer();
    const { telemetry, events } = capturingTelemetry();
    wrapServerWithTelemetry(server, telemetry);

    toolFnOf(server)("task_status", "desc", {}, async () => {
      throw new TypeError("leaked bearer token abc123");
    });

    await expect(registered.get("task_status")?.({})).rejects.toThrow(
      "leaked bearer token abc123",
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.props.outcome).toBe("error");
    expect(events[0]?.props.error_class).toBe("TypeError");
    expect(JSON.stringify(events[0]?.props)).not.toContain("leaked bearer");
  });

  it("classifies a returned isError result carrying a denial as refused", async () => {
    const { server, registered } = makeFakeServer();
    const { telemetry, events } = capturingTelemetry();
    wrapServerWithTelemetry(server, telemetry);

    toolFnOf(server)("operator_invoke_l1", "desc", {}, async () => ({
      content: [
        { type: "text", text: JSON.stringify({ error: "materialize_denied" }) },
      ],
      isError: true,
    }));

    await registered.get("operator_invoke_l1")?.({});
    expect(events[0]?.props.outcome).toBe("refused");
  });

  it("classifies a returned isError result with no refusal wording as a generic error", async () => {
    const { server, registered } = makeFakeServer();
    const { telemetry, events } = capturingTelemetry();
    wrapServerWithTelemetry(server, telemetry);

    toolFnOf(server)("daemon_status", "desc", {}, async () => ({
      content: [{ type: "text", text: "daemon_unavailable: fetch failed" }],
      isError: true,
    }));

    await registered.get("daemon_status")?.();
    expect(events[0]?.props.outcome).toBe("error");
  });

  it("re-throws the original error unchanged after tracking it", async () => {
    const { server, registered } = makeFakeServer();
    const { telemetry } = capturingTelemetry();
    wrapServerWithTelemetry(server, telemetry);

    const original = new RangeError("boom");
    toolFnOf(server)("task_terminate", "desc", {}, async () => {
      throw original;
    });

    await expect(registered.get("task_terminate")?.({})).rejects.toBe(original);
  });

  it("keeps working (unwrapped) with no telemetry configured", async () => {
    const { server, registered } = makeFakeServer();
    wrapServerWithTelemetry(server); // no telemetry arg, no env key => no-op

    toolFnOf(server)("host_ready", "desc", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const result = overlapCast(await registered.get("host_ready")?.());
    expect(result.content[0]?.text).toBe("ok");
  });
});
