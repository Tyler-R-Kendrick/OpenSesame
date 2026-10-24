import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ConnectPlan, connectPlan, connectPlans } from "./connect-plan.js";

const here = dirname(fileURLToPath(import.meta.url));
type McpRule = {
  service: string;
  default_scopes?: string[];
  primary_only?: boolean;
  configurable_authentication?: boolean;
};
const rules: McpRule[] = JSON.parse(
  readFileSync(
    join(here, "../../../../spec/connectors/connect-presets.json"),
    "utf8",
  ),
).mcp;

function mcpOf(plan: ConnectPlan | undefined) {
  const method = plan?.methods.find((row) => row.kind === "mcp");
  return method?.kind === "mcp" && method.mcp.status === "ok"
    ? method.mcp
    : null;
}

describe("MCP page rules come from spec/connectors/connect-presets.json", () => {
  it("gives Linear an MCP-only primary page with read selected and no configurable authentication", () => {
    const plan = connectPlan("linear");
    expect(plan?.primaryMethod).toBe("mcp");
    expect(mcpOf(plan)).toMatchObject({
      defaultScopes: ["read"],
      configurable: false,
    });
  });

  it("names only services with a published MCP method and scopes it advertises", () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const mcp = mcpOf(connectPlan(rule.service));
      expect(mcp, rule.service).not.toBeNull();
      for (const scope of rule.default_scopes ?? [])
        expect(mcp?.scopes, rule.service).toContain(scope);
    }
  });

  it("leaves every plan without a rule on the generic defaults", () => {
    const ruled = new Set(rules.map((rule) => rule.service));
    for (const plan of connectPlans().filter((row) => !ruled.has(row.id))) {
      expect(plan.primaryMethod, plan.id).toBeUndefined();
      expect(mcpOf(plan)?.defaultScopes, plan.id).toBeUndefined();
      expect(mcpOf(plan)?.configurable, plan.id).toBeUndefined();
    }
  });
});
