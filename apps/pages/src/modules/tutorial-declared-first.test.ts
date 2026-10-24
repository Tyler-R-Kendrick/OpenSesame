/** @vitest-environment jsdom */
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { afterEach, expect, it, vi } from "vitest";
import { createTestContext } from "./test-context.js";

/**
 * A control mounts its guide target once, when it is drawn. A target nobody
 * has declared yet binds nothing (and throws in development), and the ref does
 * not run again when the declaration lands, so a tutorial would find no
 * control. Every module that contributes tutorial targets therefore declares
 * them before it registers anything a page can draw. (identity.siop declares
 * goals only, and notifications.routing declares its tutorial with the page
 * it adds, target before page.)
 */
const MODULES: Record<
  string,
  () => Promise<{ capabilityRuntime: CapabilityRuntime }>
> = {
  "access.authority": () => import("./access.authority/runtime.js"),
  "activity.log": () => import("./activity.log/runtime.js"),
  "connectors.external": () => import("./connectors.external/runtime.js"),
  "enterprise.directory-provisioning": () =>
    import("./enterprise.directory-provisioning/runtime.js"),
  "identity.federation": () => import("./identity.federation/runtime.js"),
  "identity.local-iam": () => import("./identity.local-iam/runtime.js"),
  "networking.tailnet-devices": () =>
    import("./networking.tailnet-devices/runtime.js"),
  "notifications.local": () => import("./notifications.local/runtime.js"),
  "sharing.drops": () => import("./sharing.drops/runtime.js"),
  "sharing.live": () => import("./sharing.live/runtime.js"),
  "sharing.trusted-contacts": () =>
    import("./sharing.trusted-contacts/runtime.js"),
  "wallet.spending": () => import("./wallet.spending/runtime.js"),
};

const disposals: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(Object.keys(MODULES))(
  "%s declares its tutorial targets before anything it draws",
  async (capability) => {
    const loader = MODULES[capability];
    if (!loader) throw new Error(`No module for ${capability}`);
    const { capabilityRuntime } = await loader();
    const t = createTestContext({ tomb: "personal" });
    const handle = await capabilityRuntime.activate(t.ctx);
    disposals.push(() => handle.dispose());
    const kinds = t.registered.map((record) => record.kind);
    const lastTarget = kinds.lastIndexOf("tutorial-target");
    expect(lastTarget, `${capability} declares a target`).toBeGreaterThan(-1);
    const firstOther = kinds.findIndex((kind) => !kind.startsWith("tutorial-"));
    expect(
      firstOther === -1 || lastTarget < firstOther,
      `${capability} registered ${kinds.join(", ")}`,
    ).toBe(true);
  },
  // A module's first import compiles its whole graph.
  60_000,
);
