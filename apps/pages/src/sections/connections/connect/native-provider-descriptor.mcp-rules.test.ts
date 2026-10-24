import {
  type ConnectPlan,
  connectPlan,
} from "@opensesame/app-core/lib/connect-plan.js";
import { expect, it } from "vitest";
import {
  planDefaultMcpScopes,
  planPageMethods,
} from "./native-mcp-descriptor.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

const availability = {
  callbackUrl: "https://app.example/auth/native-connector.html",
  apiKey: { available: true },
  oauth: { available: true, registeredAvailable: true },
  mcp: { available: true, actor: "user" },
};

/** Which of Linear's spec rules a test plan carries. */
type McpPageRules = { primary: boolean; configurable: boolean };

/** Vercel's plan with Linear's rules: the descriptor reads the plan, never the id. */
function ruled(rules: McpPageRules) {
  const found = connectPlan("vercel");
  if (!found) throw new Error("Expected compiled Vercel plan");
  const plan: ConnectPlan = structuredClone(found);
  if (rules.primary) plan.primaryMethod = "mcp";
  for (const method of plan.methods)
    if (method.kind === "mcp" && method.mcp.status === "ok") {
      method.mcp.defaultScopes = method.mcp.scopes.slice(0, 1);
      method.mcp.configurable = rules.configurable;
    }
  return plan;
}

/** The page Settings draws for a plan: its rules applied as NativeConnectorPanels applies them. */
function page(plan: ConnectPlan, savedMethod?: string) {
  return planPageMethods(
    nativeProviderDescriptor(plan, {
      ...availability,
      mcp: { ...availability.mcp, defaultScopes: planDefaultMcpScopes(plan) },
    }),
    plan,
    savedMethod,
  );
}

it("offers only the plan's primary MCP method, its default permission selected", () => {
  const plan = ruled({
    primary: true,
    configurable: false,
  } satisfies McpPageRules);
  const descriptor = page(plan);
  expect(descriptor.methods.map((method) => method.id)).toEqual(["mcp"]);
  const mcp = descriptor.methods[0];
  expect(mcp?.fields).toEqual([]);
  const [first, ...rest] = mcp?.scopeGroups[0]?.choices ?? [];
  expect(first?.default).toBe(true);
  expect(rest.every((scope) => scope.default === false)).toBe(true);
});

it("keeps a saved record on its own method", () => {
  const plan = ruled({
    primary: true,
    configurable: false,
  } satisfies McpPageRules);
  expect(page(plan, "oauth").methods.map((method) => method.id)).toEqual([
    "oauth",
  ]);
});

it("keeps every method and the configurable MCP authentication without the rules", () => {
  const plan = ruled({
    primary: false,
    configurable: true,
  } satisfies McpPageRules);
  const descriptor = page(plan);
  expect(descriptor.methods.map((method) => method.id)).toContain("oauth");
  const mcp = descriptor.methods.find((method) => method.id === "mcp");
  expect(mcp?.fields.map((field) => field.id)).toContain("mcp_authentication");
});
