/** @vitest-environment jsdom */
import { composeHost, configureHost, host } from "@opensesame/app-core/host.js";
import { workerControllerSeams } from "@opensesame/app-core/lib/capabilities/worker/seams.js";
import {
  BASE,
  CORE_URL,
  DISTRIBUTION,
  PUSH_URL,
} from "@opensesame/app-core/lib/capabilities/worker/test-harness.js";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import { pushSeams } from "../../lib/push-enrolment.js";
import { createTestContext } from "../test-context.js";
import { capabilityRuntime } from "./runtime.js";

const original = { ...pushSeams };
const originalBase = workerControllerSeams.baseUrl;
const originalHost = host();

/** The shell's build, as the core reads it: through the host. */
function buildWith(distribution: () => Promise<typeof DISTRIBUTION>): void {
  configureHost(
    composeHost(originalHost, {
      env: originalHost.env,
      capabilities: { moduleTable: async () => ({}), distribution },
    }),
  );
}

const running = (scriptURL: string): ServiceWorkerRegistration =>
  // SAFETY: the check under test reads `active.scriptURL` and nothing else.
  overlapCast({ active: { scriptURL } });

afterEach(() => {
  Object.assign(pushSeams, original);
  workerControllerSeams.baseUrl = originalBase;
  configureHost(originalHost);
});

describe("notifications.web-push knows which worker can ring the doorbell", () => {
  it("counts only the push variant's script while it is active, and puts the default back on dispose", async () => {
    workerControllerSeams.baseUrl = () => BASE;
    buildWith(async () => DISTRIBUTION);
    const handle = await capabilityRuntime.activate(createTestContext().ctx);
    expect(pushSeams.workerIsPush(running(PUSH_URL))).toBe(true);
    expect(pushSeams.workerIsPush(running(CORE_URL))).toBe(false);
    await handle.dispose();
    expect(pushSeams.workerIsPush).toBe(original.workerIsPush);
  });

  it("leaves every worker counting when the build names no push variant", async () => {
    buildWith(async () => ({
      ...DISTRIBUTION,
      workerVariants: DISTRIBUTION.workerVariants.filter(
        (variant) => variant.id !== "push",
      ),
    }));
    const handle = await capabilityRuntime.activate(createTestContext().ctx);
    expect(pushSeams.workerIsPush).toBe(original.workerIsPush);
    await handle.dispose();
  });

  it("leaves every worker counting when the host has no distribution to read", async () => {
    buildWith(async () => {
      throw new Error("no distribution");
    });
    const handle = await capabilityRuntime.activate(createTestContext().ctx);
    expect(pushSeams.workerIsPush).toBe(original.workerIsPush);
    await handle.dispose();
  });
});
