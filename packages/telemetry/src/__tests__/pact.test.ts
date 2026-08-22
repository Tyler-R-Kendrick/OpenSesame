import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@opensesame/os-domain";
import {
  assertAtMostWins,
  assertNoSecretFields,
  assertSourceOrder,
} from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_EVENTS,
  createTelemetry,
  redactionTest,
} from "../telemetry.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — telemetry", () => {
  it("property: every allowed event forwards and unknown events never capture", () => {
    const events: Array<{ event: string; props: JsonObject }> = [];
    const telemetry = createTelemetry({
      capture: (event, props) => events.push({ event, props }),
    });
    for (const event of ALLOWED_EVENTS) telemetry.track(event);
    expect(events.map((e) => e.event)).toEqual([...ALLOWED_EVENTS]);
    telemetry.track("password_reset");
    telemetry.track("access_token_issued");
    expect(events).toHaveLength(ALLOWED_EVENTS.length);
  });

  it("adversarial: forbidden values are dropped not redacted", () => {
    const events: Array<{ event: string; props: JsonObject }> = [];
    const telemetry = createTelemetry({
      capture: (event, props) => events.push({ event, props }),
    });
    for (const row of redactionTest) {
      events.length = 0;
      telemetry.track("mcp_tool_call", {
        tool: "task_start",
        [row.key]: row.value,
      });
      expect(events[0]?.props).not.toHaveProperty(row.key);
      expect(JSON.stringify(events[0]?.props)).not.toContain(row.value);
    }
  });

  it("chaos: concurrent secret-shaped tracks never leak into capture", async () => {
    const captured: JsonObject[] = [];
    const telemetry = createTelemetry({
      capture: (_event, props) => captured.push(props),
    });
    await assertAtMostWins(() => {
      telemetry.track("mcp_tool_call", {
        tool: "task_start",
        outcome: "Bearer sk-secret-abc",
      });
      return JSON.stringify(captured.at(-1)).includes("sk-secret");
    }, 0);
    for (const props of captured) {
      assertNoSecretFields(props);
    }
  });

  it("contract: sanitize runs before capture", () => {
    assertSourceOrder(readFileSync(join(here, "../telemetry.ts"), "utf8"), [
      "if (!allowedEvents.has(event)) return",
      "capture(event, sanitizeProps(props))",
    ]);
  });
});
