import { describe, expect, it } from "vitest";
import { connectPlan, connectPlans } from "./connect-plan.js";
import { readDeviceRows } from "./device-connector-records.js";
import {
  nativeMcpUnavailableReason,
  supportsNativeMcpProvider,
} from "./native-mcp-connectors.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";

installNativeMcpConnectorTests();

const unsupported = [
  "alchemy",
  "asana",
  "biorender",
  "box",
  "candid",
  "coda",
  "crossbeam",
  "egnyte",
  "g2",
  "gusto",
  "hugging-face",
  "make",
  "mem0",
  "miro",
  "oreilly",
  "pagerduty",
  "planetscale",
  "reclaim-ai",
  "supabase",
  "vercel",
  "xero",
  "zoominfo",
  "ticket-tailor",
  "vantage",
];

describe("compiled public MCP browser availability", () => {
  it.each(unsupported)(
    "refuses incomplete or confidential %s before offering consent",
    (id) => {
      expect(
        connectPlan(id)?.methods.some((method) => method.kind === "mcp"),
      ).toBe(true);
      expect(supportsNativeMcpProvider(id)).toBe(false);
      expect(nativeMcpUnavailableReason(id)).toMatch(/public|browser/);
    },
  );
  it("direct configuration rejects a confidential provider before creating a sealed record", async () => {
    await expect(mcpConnectorFixture({ providerId: "asana" })).rejects.toThrow(
      "public clients without a client secret",
    );
    expect(readDeviceRows()).toHaveLength(0);
  });
  it("admits every complete public tuple while preserving actual registration choices", () => {
    const admitted = connectPlans().filter((plan) =>
      supportsNativeMcpProvider(plan.id),
    );
    expect(admitted).toHaveLength(71);
    expect(supportsNativeMcpProvider("adobe")).toBe(true);
    expect(supportsNativeMcpProvider("notion")).toBe(true);
    expect(supportsNativeMcpProvider("stripe")).toBe(false);
    expect(supportsNativeMcpProvider("unknown-provider")).toBe(false);
  });
});
