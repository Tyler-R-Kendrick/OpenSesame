import { VAULT_RESET_RUNS_KEY } from "@opensesame/app-core/lib/password-reset/vault-run-tracker.js";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../test-context.js";
import { capabilityRuntime } from "./runtime.js";

describe("password reset runtime", () => {
  it("hydrates tracked jobs before registering the notice bridge", async () => {
    const context = createTestContext();
    let releaseHydration: () => void = () => {
      throw new Error("hydration was not started");
    };
    const barrier = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const activation = capabilityRuntime.activate({
      ...context.ctx,
      hydrate: async (keys) => {
        await barrier;
        await context.ctx.hydrate(keys);
      },
    });
    expect(context.registered).toEqual([]);
    releaseHydration();
    const handle = await activation;
    try {
      expect(context.hydrated).toEqual([[VAULT_RESET_RUNS_KEY]]);
      expect(context.entries("background-job")).toContainEqual(
        expect.objectContaining({ id: "password-reset-run-notices" }),
      );
    } finally {
      handle.dispose();
    }
  });

  it("registers the takeover route through the approved capability", async () => {
    const context = createTestContext();
    const handle = await capabilityRuntime.activate(context.ctx);
    try {
      expect(context.entries("route")).toContainEqual(
        expect.objectContaining({
          id: "password-reset-takeover",
          path: "/runs/:runId",
          framed: true,
        }),
      );
    } finally {
      handle.dispose();
    }
  });
});
