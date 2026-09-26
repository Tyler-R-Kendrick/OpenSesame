/** @vitest-environment jsdom */
/**
 * The surface exposes a contributed tool only while the plan approves the
 * operation it is owned by — the first it is tagged with — and never an
 * untagged one (`approvedTool`). So a runtime that registers a tool without
 * its tag silently loses it, and a tool whose first id belongs to some other
 * withdrawable capability disappears with that one instead of its own.
 * Activate every module and check each tool: tagged, every id owned by some
 * capability, and the first owned by the registering capability or by one
 * with no module (the core an operator cannot withdraw, ADR 0142).
 */
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import type { CapabilityModule } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { describe, expect, it } from "vitest";
import { readOperationIds } from "../ports-b.js";
import { runtimeOf } from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";

const OWNED = new Set(
  CAPABILITY_CATALOG.capabilities.flatMap((entry) => entry.operationIds),
);

/**
 * A tool deliberately owned by another capability's operation. The boot
 * health tool reports what `host.health.pages` covers, and the catalog puts
 * that operation under `access.authority`: withdrawing it withdraws the tool.
 */
const OWNED_ELSEWHERE = new Map([["opensesame_health", "access.authority"]]);

/** Whether `operation` may own a tool `capability` registers. */
function mayOwn(capability: string, tool: string, operation: string): boolean {
  const owner = OWNED_ELSEWHERE.get(tool) ?? capability;
  return CAPABILITY_CATALOG.capabilities.some(
    (entry) =>
      entry.operationIds.includes(operation) &&
      (entry.id === owner || entry.moduleIds.length === 0),
  );
}
const RUNTIMES = import.meta.glob<Partial<CapabilityModule>>("../*/runtime.ts");

describe("every contributed WebMCP tool is tagged", () => {
  it.each(Object.keys(RUNTIMES))(
    "%s tags its tools with approvable operations",
    async (path) => {
      const load = RUNTIMES[path];
      if (!load) throw new Error(`no loader for ${path}`);
      const runtime = runtimeOf(await load());
      const t = createTestContext();
      const handle = await runtime.activate(t.ctx);
      try {
        for (const tool of t.entries("webmcp-tool")) {
          const ids = readOperationIds(tool);
          expect(ids, tool.name).not.toBeNull();
          const [owner = ""] = ids ?? [];
          expect(
            mayOwn(runtime.capability, tool.name, owner),
            `${tool.name}: ${owner}`,
          ).toBe(true);
          for (const id of ids ?? [])
            expect(OWNED.has(id), `${tool.name}: ${id}`).toBe(true);
        }
      } finally {
        await handle.dispose();
      }
    },
  );
});
