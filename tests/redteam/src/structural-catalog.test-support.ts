import {
  AGENT_SECRET_NAME_PATTERN,
  mcpHostCatalog,
} from "@opensesame/capability-registry";
import { describe, expect, it } from "vitest";
import { probe } from "./structural-probe.js";

export function registerCatalogParityTests() {
  describe("catalog parity (live server vs registry)", () => {
    it("advertises exactly the registry's mcp_host catalog, all denylist-clean", async () => {
      const data = await probe({
        calls: [{ tool: "host_ready", params: {} }],
        includeToolSchemas: true,
        mockRoutes: [
          {
            path: "/health/ready",
            method: "GET",
            status: 200,
            body: { status: "ok" },
          },
        ],
      });
      const advertised = (data.tools ?? []).map((tool) => tool.name).sort();
      expect(advertised).toEqual([...mcpHostCatalog()].sort());
      for (const name of advertised) {
        expect(name).not.toMatch(AGENT_SECRET_NAME_PATTERN);
      }
    });
  });
}
