/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  ENVIRONMENTS_CAPABILITY,
  enableVaultEnvironments,
  markEnvironmentRequired,
  notifyMissingEnvironmentValues,
  resetVaultEnvironments,
  switchEnvironment,
} from "@opensesame/app-core/lib/vault/environments.js";
import { describe, expect, it } from "vitest";
import {
  profilePlan,
  profileSelection,
} from "../../lib/capabilities/__tests__/vault-profiles.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("vault.environments runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers only the vaults settings panel", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.environments",
      kinds: ["settings-panel"],
      count: 1,
    });
  });

  it("names the panel on the vaults category", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("settings-panel")).toEqual([
      expect.objectContaining({
        id: "vault-environments",
        label: "Environments",
        category: "vaults",
        order: 60,
      }),
    ]);
    await handle.dispose();
  });

  it("clears the missing-value notice when the capability is disposed", async () => {
    resetVaultEnvironments();
    clearNotices();
    const plan = profilePlan("minimal-local", {
      installation: {
        ...profileSelection("minimal-local"),
        selectedOptional: [ENVIRONMENTS_CAPABILITY],
      },
    });
    enableVaultEnvironments(plan, "personal");
    switchEnvironment(plan, "personal", "production");
    markEnvironmentRequired(plan, "personal", "production", "item-token", true);
    notifyMissingEnvironmentValues(plan, "personal", [
      { id: "item-token", key: "API_TOKEN" },
    ]);
    expect(listNotices().map((notice) => notice.id)).toContain(
      "vault.environments.missing",
    );
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    await handle.dispose();
    expect(listNotices().map((notice) => notice.id)).not.toContain(
      "vault.environments.missing",
    );
    resetVaultEnvironments();
    clearNotices();
  });
});
