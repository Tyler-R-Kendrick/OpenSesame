import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import {
  registerContributionForTest,
  resetContributionsForTest,
} from "@opensesame/app-core/lib/contributions.js";
import type { EffectivePlan } from "@opensesame/capability-composition";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tagWebMcpTool } from "../ports-b.js";
import { approvedTool, contributedTools } from "./surface.js";

function tool(name: string, operations: string[]): WebMcpToolSpec {
  return tagWebMcpTool({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({}),
    capabilityIds: operations,
    scope: "boot",
  });
}

afterEach(() => {
  resetContributionsForTest();
  vi.restoreAllMocks();
});

describe("the WebMCP surface exposes only what the plan approves", () => {
  it("needs the operation it is owned by, not every one it serves", () => {
    // The identity summary is owned by identity.whoami and also serves
    // identity.admin, which only directory provisioning approves.
    const both = tool("both", ["identity.whoami", "identity.admin"]);
    expect(approvedTool(both, ["identity.whoami"])).toBe(true);
    expect(approvedTool(both, ["identity.admin"])).toBe(false);
  });

  it("never exposes an untagged tool", () => {
    const untagged: WebMcpToolSpec = {
      name: "untagged",
      description: "",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
    };
    expect(approvedTool(untagged, ["app.status"])).toBe(false);
  });

  it("drops a contributed tool whose operation the plan withdrew", () => {
    registerContributionForTest("webmcp-tool", tool("kept", ["app.status"]));
    registerContributionForTest(
      "webmcp-tool",
      tool("withdrawn", ["vault.export"]),
    );
    const plan: EffectivePlan = {
      identity: {
        instanceId: "surface-test",
        installationId: "surface-test",
        vaultId: null,
        distributionId: "surface-test",
        policyRevision: "surface-test",
        selectionRevision: "1",
        planDigest: "sha256:surface-test",
      },
      provenance: "personal-local",
      policyValid: true,
      capabilities: {},
      approvedCapabilities: [],
      approvedModules: [],
      approvedOperations: ["app.status"],
      approvedItemKinds: [],
      requiredWorkerVariant: null,
      conflicts: [],
      consent: {
        addedRoots: [],
        removedRoots: [],
        changedExposure: [],
        addedDependencies: [],
        requiredNotAccepted: [],
      },
      network: { externalServices: "allow", allowedServiceOrigins: [] },
    };
    vi.spyOn(compositionStore, "getSnapshot").mockReturnValue({
      ...compositionStore.getSnapshot(),
      plan,
    });
    expect(contributedTools("boot").map((t) => t.name)).toEqual(["kept"]);
  });
});
