import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDurableSurvivesPartition,
  assertSourceOrder,
} from "@opensesame/testing";
import { describe, it } from "vitest";
import { startMockUpstream } from "./mock-upstream.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — redteam harness", () => {
  it("property: corpus covers the four attack classes", () => {
    const testsDir = join(here, "../tests");
    const files = readdirSync(testsDir).filter((f) => f.endsWith(".yaml"));
    for (const required of [
      "credential-exfiltration.yaml",
      "confused-deputy.yaml",
      "malformed-input.yaml",
      "prompt-injection.yaml",
    ]) {
      assert.ok(files.includes(required), required);
    }
  });

  it("adversarial: 404 mock bodies have no secret fields", async () => {
    const mock = await startMockUpstream([]);
    try {
      const res = await fetch(`${mock.url}/v1/secret`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "mock_upstream_no_route");
      assert.equal(JSON.stringify(body).includes("access_token"), false);
    } finally {
      await mock.close();
    }
  });

  it("chaos: unmatched routes stay 404 after a flood of requests", async () => {
    const mock = await startMockUpstream([
      { path: "/health", body: { ok: true } },
    ]);
    try {
      await assertDurableSurvivesPartition(
        async () => {
          const health = await fetch(`${mock.url}/health`);
          return health.ok ? 1 : 0;
        },
        async () => {
          await Promise.all(
            Array.from({ length: 32 }, () => fetch(`${mock.url}/missing`)),
          );
        },
      );
    } finally {
      await mock.close();
    }
  });

  it("contract: mcp-host structural provider never names a getSecret tool", () => {
    assertSourceOrder(readFileSync(join(here, "mcp-provider.ts"), "utf8"), [
      "class McpHostStructuralProvider",
      "client.callTool",
    ]);
    const src = readFileSync(join(here, "mcp-provider.ts"), "utf8");
    assert.equal(/getSecret/.test(src), false);
  });
});
