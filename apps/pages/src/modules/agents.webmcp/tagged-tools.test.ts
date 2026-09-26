/** @vitest-environment jsdom */
/**
 * The surface exposes a contributed tool only when the plan approves every
 * operation it is tagged with, and an untagged tool is never exposed
 * (`approvedTool`). So a runtime that registers a tool without its tag
 * silently loses it, and one tagged with an operation no capability owns
 * can never be approved. Activate every module and check both.
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
          for (const id of ids ?? [])
            expect(OWNED.has(id), `${tool.name}: ${id}`).toBe(true);
        }
      } finally {
        await handle.dispose();
      }
    },
  );
});
