import assert from "node:assert/strict";
import {
  AGENT_SECRET_NAME_PATTERN,
  assertsNoSecretNames,
  mcpClientCatalog,
  mcpHostCatalog,
  webmcpCatalog,
} from "@opensesame/capability-registry";
import { overlapCast } from "@opensesame/os-domain";
import { assertDurableSurvivesPartition } from "@opensesame/testing";
import { describe, it } from "vitest";
import { startMockUpstream } from "./mock-upstream.js";

describe("PACT — redteam harness", () => {
  it("adversarial: 404 mock bodies have no secret fields", async () => {
    const mock = await startMockUpstream([]);
    try {
      const res = await fetch(`${mock.url}/v1/secret`);
      assert.equal(res.status, 404);
      const body = overlapCast(await res.json());
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

  it("property: the registry catalogs clear the secret-name denylist", () => {
    // The mcp_host and mcp_client surfaces went away with the authority plane;
    // their catalogs must stay empty, and the surviving webmcp catalog stays
    // non-empty and clean.
    assert.equal(mcpHostCatalog().length, 0);
    assert.equal(mcpClientCatalog().length, 0);
    const catalog = webmcpCatalog();
    assert.ok(catalog.length > 0);
    assertsNoSecretNames(catalog);
    for (const name of catalog) {
      assert.equal(
        AGENT_SECRET_NAME_PATTERN.test(name),
        false,
        `secret-shaped tool name in registry catalog: ${name}`,
      );
    }
  });
});
