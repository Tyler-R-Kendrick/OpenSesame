import { describe, expect, it } from "vitest";
import {
  ALLOWED_EVENTS,
  ALLOWED_PROP_KEYS,
  createTelemetry,
  redactionTest,
} from "../telemetry.js";
import { type JsonObject, overlapCast, isString } from "@opensesame/os-domain";

function capturing() {
  const events: Array<{ event: string; props: JsonObject }> = [];
  const telemetry = createTelemetry({
    capture: (event, props) => events.push({ event, props }),
  });
  return { telemetry, events };
}

describe("createTelemetry — event allowlist", () => {
  it("forwards every allowed event", () => {
    const { telemetry, events } = capturing();
    for (const event of ALLOWED_EVENTS) {
      telemetry.track(event);
    }
    expect(events.map((e) => e.event)).toEqual([...ALLOWED_EVENTS]);
  });

  it("silently drops an unknown event (no capture call, no throw)", () => {
    const { telemetry, events } = capturing();
    expect(() => telemetry.track("totally_made_up_event")).not.toThrow();
    telemetry.track("page_view"); // looks plausible, is not on the allowlist
    expect(events).toHaveLength(0);
  });

  it("treats the allowlist as case- and shape-sensitive (no fuzzy matching)", () => {
    const { telemetry, events } = capturing();
    telemetry.track("App_Opened");
    telemetry.track("app-opened");
    telemetry.track(" app_opened");
    expect(events).toHaveLength(0);
  });
});

describe("createTelemetry — prop allowlist", () => {
  it("keeps only allowlisted prop keys", () => {
    const { telemetry, events } = capturing();
    telemetry.track("mcp_tool_call", {
      tool: "task_start",
      duration_ms: 12,
      outcome: "ok",
      // Not on the allowlist — must be dropped silently, not throw.
      arguments: { principal_id: "p1" },
      session_id: "abc",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.props).toEqual({
      tool: "task_start",
      duration_ms: 12,
      outcome: "ok",
    });
  });

  it("emits an empty props object for an allowed event with no props", () => {
    const { telemetry, events } = capturing();
    telemetry.track("app_opened");
    expect(events).toEqual([{ event: "app_opened", props: {} }]);
  });

  it("emits an empty props object when every prop is unknown", () => {
    const { telemetry, events } = capturing();
    telemetry.track("vault_locked", { user_id: "u1", ip: "1.2.3.4" });
    expect(events).toEqual([{ event: "vault_locked", props: {} }]);
  });

  it("accepts every documented prop key when its value is benign", () => {
    const { telemetry, events } = capturing();
    telemetry.track("mcp_tool_call", {
      tool: "task_status",
      client: "claude-code",
      client_version: "1.2.3",
      duration_ms: 42,
      outcome: "ok",
      error_class: "TypeError",
      item_type: "connection",
      queue_depth: 3,
    });
    expect(events[0]?.props).toEqual({
      tool: "task_status",
      client: "claude-code",
      client_version: "1.2.3",
      duration_ms: 42,
      outcome: "ok",
      error_class: "TypeError",
      item_type: "connection",
      queue_depth: 3,
    });
    // Sanity: every key we just asserted is actually documented as allowed.
    for (const key of Object.keys(events[0]?.props ?? {})) {
      expect(overlapCast(ALLOWED_PROP_KEYS)).toContain(key);
    }
  });
});

describe("createTelemetry — primitive coercion", () => {
  it("passes numbers and booleans through unchanged", () => {
    const { telemetry, events } = capturing();
    telemetry.track("mcp_tool_call", { duration_ms: 7.5, queue_depth: 0 });
    expect(events[0]?.props).toEqual({ duration_ms: 7.5, queue_depth: 0 });
  });

  it("stringifies everything else (objects, arrays, null)", () => {
    const { telemetry, events } = capturing();
    telemetry.track("item_opened", {
      item_type: overlapCast({ nested: "object" }),
    });
    expect(isString(events[0]?.props.item_type)).toBe(true);
  });

  it("truncates strings to 64 characters", () => {
    const { telemetry, events } = capturing();
    const long = "x".repeat(200);
    telemetry.track("item_opened", { item_type: long });
    expect(events[0]?.props.item_type).toBe("x".repeat(64));
    expect((overlapCast(events[0]?.props.item_type)).length).toBe(64);
  });

  it("does not truncate short strings", () => {
    const { telemetry, events } = capturing();
    telemetry.track("item_opened", { item_type: "note" });
    expect(events[0]?.props.item_type).toBe("note");
  });
});

describe("createTelemetry — forbidden content is dropped, not redacted", () => {
  it.each(redactionTest)(
    "drops the whole prop when the value smuggles a forbidden term ($label)",
    ({ key, value }) => {
      const { telemetry, events } = capturing();
      telemetry.track("mcp_tool_call", { tool: "task_start", [key]: value });
      expect(events).toHaveLength(1);
      // The prop is gone entirely — not present as a redacted placeholder —
      // and nothing about the forbidden value leaks through in any form.
      expect(events[0]?.props).not.toHaveProperty(key);
      expect(JSON.stringify(events[0]?.props)).not.toContain(
        value.toLowerCase(),
      );
    },
  );

  it("still keeps sibling props that are clean", () => {
    const { telemetry, events } = capturing();
    telemetry.track("mcp_tool_call", {
      tool: "task_start",
      duration_ms: 5,
      outcome: "Bearer sk-secret-abc", // forbidden — dropped
    });
    expect(events[0]?.props).toEqual({ tool: "task_start", duration_ms: 5 });
  });

  it("drops a prop whose key name itself is sensitive, even off-allowlist smuggling attempts", () => {
    const { telemetry, events } = capturing();
    telemetry.track("mcp_tool_call", {
      tool: "task_start",
      // Not on the allowlist at all — dropped by the allowlist check first.
      access_token: "should-never-appear",
    });
    expect(events[0]?.props).toEqual({ tool: "task_start" });
  });

  it("is case-insensitive when matching forbidden substrings", () => {
    const { telemetry, events } = capturing();
    telemetry.track("mcp_tool_call", {
      tool: "task_start",
      outcome: "BEARER SK-SECRET-ABC",
    });
    expect(events[0]?.props).toEqual({ tool: "task_start" });
  });
});
