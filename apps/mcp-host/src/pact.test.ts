import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSecretFields, assertSourceOrder } from "@opensesame/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPayloadRefused, forAgent } from "./agent-payload.js";
import { hostFetch, resetFetchForTests, setFetchForTests } from "./host-api.js";
import { assertsNoSecretTools, hostTools } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — mcp-host", () => {
  afterEach(() => {
    resetFetchForTests();
    Reflect.deleteProperty(process.env, "OPENSESAME_SERVER");
    Reflect.deleteProperty(process.env, "OPENSESAME_OPERATOR_TOKEN");
  });

  it("property: catalog names stay free of secret verbs", () => {
    for (const name of hostTools) {
      expect(name).not.toMatch(/secret|materialize|pass_show|^show$/i);
    }
    expect(() => assertsNoSecretTools(hostTools)).not.toThrow();
  });

  it("adversarial: tool errors and Host audience go through forAgent", () => {
    assertSourceOrder(readFileSync(join(here, "tools.ts"), "utf8"), [
      "function toolError",
      "forAgent(`${label}: ${message}`)",
    ]);
    assertSourceOrder(readFileSync(join(here, "host-api.ts"), "utf8"), [
      "OPENSESAME_HOST_AUDIENCE",
      "does not match OPENSESAME_HOST_AUDIENCE",
    ]);
    expect(() => forAgent(JSON.stringify({ refresh_token: "leak" }))).toThrow(
      AgentPayloadRefused,
    );
  });

  it("chaos: Host partition maps to host_unavailable, not an open tool", async () => {
    process.env.OPENSESAME_SERVER = "http://127.0.0.1:8787";
    process.env.OPENSESAME_OPERATOR_TOKEN = "opensesame-dev-operator";
    setFetchForTests(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(hostFetch("/health/ready")).rejects.toThrow(/ECONNREFUSED/);
    assertSourceOrder(readFileSync(join(here, "tools.ts"), "utf8"), [
      'const res = await hostFetch("/health/ready")',
      'toolError("host_unavailable"',
    ]);
  });

  it("contract: hostTools JSON has no secret fields", () => {
    assertNoSecretFields({ tools: [...hostTools] });
    expect(hostTools).toEqual(
      expect.arrayContaining([
        "task_start",
        "task_status",
        "task_invoke",
        "task_terminate",
        "daemon_status",
        "host_ready",
        "operator_invoke_l1",
      ]),
    );
  });
});
