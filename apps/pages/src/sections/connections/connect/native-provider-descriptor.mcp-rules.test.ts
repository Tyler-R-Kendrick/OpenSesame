/** @vitest-environment jsdom */
import {
  type ConnectPlan,
  connectPlan,
} from "@opensesame/app-core/lib/connect-plan.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { expect, it } from "vitest";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";
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

it("offers only the plan's primary MCP method, its default permission selected", () => {
  const plan = ruled({
    primary: true,
    configurable: false,
  } satisfies McpPageRules);
  const descriptor = nativeProviderDescriptor(plan, {
    ...availability,
    mcp: {
      ...availability.mcp,
      defaultScopes: plan.methods.flatMap((method) =>
        method.kind === "mcp" && method.mcp.status === "ok"
          ? (method.mcp.defaultScopes ?? [])
          : [],
      ),
    },
  });
  expect(descriptor.methods.map((method) => method.id)).toEqual(["mcp"]);
  const mcp = descriptor.methods[0];
  expect(mcp?.fields).toEqual([]);
  const [first, ...rest] = mcp?.scopeGroups[0]?.choices ?? [];
  expect(first?.default).toBe(true);
  expect(rest.every((scope) => scope.default === false)).toBe(true);
});

it("keeps every method and the configurable MCP authentication without the rules", () => {
  const plan = ruled({
    primary: false,
    configurable: true,
  } satisfies McpPageRules);
  const descriptor = nativeProviderDescriptor(plan, availability);
  expect(descriptor.methods.map((method) => method.id)).toContain("oauth");
  const mcp = descriptor.methods.find((method) => method.id === "mcp");
  expect(mcp?.fields.map((field) => field.id)).toContain("mcp_authentication");
});

it("keeps a primary MCP route configurable when the plan permits operator credentials", () => {
  const plan = ruled({ primary: true, configurable: true });
  const descriptor = nativeProviderDescriptor(plan, availability);
  expect(descriptor.methods.map((method) => method.id)).toEqual(["mcp"]);
  const fields = descriptor.methods[0]?.fields.map((field) => field.id);
  expect(fields).toContain("mcp_authentication");
  expect(fields).toContain("mcp_url");
  expect(fields).toContain("mcp_token");
});

it("honors empty and read-only caller scope defaults ahead of the plan's defaults", () => {
  const plan = ruled({ primary: true, configurable: false });
  const method = plan.methods.find((entry) => entry.kind === "mcp");
  if (method?.kind !== "mcp" || method.mcp.status !== "ok")
    throw new Error("Expected compiled MCP metadata");
  method.mcp.scopes = ["read", "write"];
  method.mcp.defaultScopes = ["write"];
  for (const defaults of [[], ["read"]]) {
    const descriptor = nativeProviderDescriptor(plan, {
      ...availability,
      mcp: { ...availability.mcp, defaultScopes: defaults },
    });
    expect(
      descriptor.methods[0]?.scopeGroups[0]?.choices
        .filter((scope) => scope.default)
        .map((scope) => scope.name),
    ).toEqual(defaults);
  }
});

it("does not substitute another connection method when primary MCP is inactive", () => {
  const plan = ruled({ primary: true, configurable: false });
  const descriptor = nativeProviderDescriptor(plan, {
    ...availability,
    mcp: {
      ...availability.mcp,
      available: false,
      inactiveReason: "Activate the original runtime in Features",
    },
  });
  expect(descriptor.methods.map((method) => method.id)).toEqual(["mcp"]);
  expect(descriptor.methods[0]?.available).toBe(false);
});

it("preserves a saved Linear method while new connections keep primary MCP with read selected", () => {
  const provider = catalogProvider("linear");
  if (!provider) throw new Error("Expected compiled Linear provider");
  const primary = nativeSettingsDescriptor(provider);
  expect(primary?.methods.map((method) => method.id)).toEqual(["mcp"]);
  expect(
    primary?.methods[0]?.scopeGroups[0]?.choices
      .filter((scope) => scope.default)
      .map((scope) => scope.name),
  ).toEqual(["read"]);
  for (const saved of ["oauth", "api-key", "mcp"] as const)
    expect(
      nativeSettingsDescriptor(provider, saved)?.methods.map(
        (method) => method.id,
      ),
    ).toEqual([saved]);
});

it("keeps an explicit saved method for any primary-only plan without restricting plans that have no primary", () => {
  const plan = ruled({ primary: true, configurable: false });
  expect(
    nativeProviderDescriptor(plan, availability, "api-key").methods.map(
      (method) => method.id,
    ),
  ).toEqual(["api-key"]);
  expect(
    nativeProviderDescriptor(plan, availability, "oauth").methods.map(
      (method) => method.id,
    ),
  ).toEqual(["oauth"]);
  const all = ruled({ primary: false, configurable: true });
  expect(
    nativeProviderDescriptor(all, availability, "api-key").methods.map(
      (method) => method.id,
    ),
  ).toEqual(
    nativeProviderDescriptor(all, availability).methods.map(
      (method) => method.id,
    ),
  );
});
