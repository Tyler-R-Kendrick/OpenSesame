/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enabledIdentityViews,
  resetIdentityViewsForTests,
} from "../../sections/identity/identity-views.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

const KINDS = [
  "setup-panel",
  "tutorial-goal",
  "tutorial-target",
  "webmcp-tool",
];

describe("identity.federation runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetIdentityViewsForTests();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("identity.federation");
  });

  it("registers the federation contributions and disposes them (LOAD-09)", async () => {
    const { targets, goals } = runtime.TUTORIAL;
    await expectLifecycle(runtimeOf(runtime), {
      capability: "identity.federation",
      kinds: KINDS,
      // 2 setup panels + 1 webmcp tool + tutorial descriptors
      count: 2 + 1 + targets.length + goals.length,
    });
  });

  it("names the setup tabs, the tool and the authored entries exactly", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("setup-panel").map((p) => [p.id, p.tab, p.rail, p.order]),
    ).toEqual([
      ["identity", "identity", "Identity", 30],
      ["mfa", "mfa", "MFA", 40],
    ]);
    const tools = t.entries("webmcp-tool");
    expect(tools.map((tool) => tool.name)).toEqual([
      "opensesame_identity_read",
    ]);
    // SURFACE-05: the core filters contributions by approved operations.
    expect(
      (tools[0] as { operationIds?: readonly string[] }).operationIds,
    ).toEqual(["identity.whoami", "identity.admin"]);
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual([
      "identity.providers",
      "identity.register-idp",
    ]);
    expect(t.entries("tutorial-goal").map((d) => d.id)).toEqual([
      "identity.account.add",
    ]);
    expect(t.entries("tutorial-route")).toEqual([]);
    await handle.dispose();
  });

  it("puts only the Providers tab on the page, and takes it back", async () => {
    expect(enabledIdentityViews()).toEqual([]);
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(enabledIdentityViews()).toEqual(["providers"]);
    await handle.dispose();
    expect(enabledIdentityViews()).toEqual([]);
    // Idempotent: a second dispose does not decrement a second time.
    await handle.dispose();
    expect(enabledIdentityViews()).toEqual([]);
  });
});
