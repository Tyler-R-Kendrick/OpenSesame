import { planWith } from "@opensesame/app-core/lib/capabilities/__tests__/plan-with.js";
/** @vitest-environment jsdom */
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushSeams } from "../../lib/push-enrolment.js";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("notifications.web-push runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("notifications.web-push");
  });

  it("registers one settings panel, the enrolment row; the permission is the person's to grant", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "notifications.web-push",
      kinds: ["settings-panel"],
      count: 1,
    });
  });

  it("reaches no network on activation, reads only its own key, and routes enrolment through the egress port until it is disposed", async () => {
    const raw = vi.spyOn(globalThis, "fetch");
    const before = pushSeams.fetchFn;
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.egressCalls).toEqual([]);
    expect(t.hydrated).toEqual([
      ["push.subscription.id", "push.forget.pending"],
    ]);
    expect(pushSeams.fetchFn).not.toBe(before);
    const [panel] = t.entries("settings-panel");
    expect(panel?.category).toBe("general");
    await handle.dispose();
    await handle.dispose();
    // A request still in flight when the capability goes has no road out: it
    // is refused as an unapproved capability's is, never sent raw.
    await expect(
      pushSeams.fetchFn("https://identity.example.test/v1/x", {}),
    ).rejects.toMatchObject({
      name: "EgressDenied",
      code: "capability-not-approved",
    });
    expect(raw).not.toHaveBeenCalled();
    expect(t.egressCalls).toEqual([]);
  });

  it("is admitted by the real egress port under the purpose its descriptor declares", async () => {
    const descriptor = CAPABILITY_CATALOG.capabilities.find(
      (d) => d.id === "notifications.web-push",
    );
    if (!descriptor) throw new Error("catalog lacks notifications.web-push");
    const sent: string[] = [];
    const egress = createEgressPort({
      capability: descriptor,
      plan: () => planWith(["notifications.web-push"]),
      allowedOrigins: ["https://app.example.test"],
      fetchImpl: async (input) => {
        sent.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });
    const raw = vi.spyOn(globalThis, "fetch");
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate({
      ...t.ctx,
      egress,
    });
    const url =
      "https://identity.example.test/v1/notification-channels/push/key";
    const response = await pushSeams.fetchFn(url, { method: "GET" });
    expect(response.status).toBe(200);
    expect(sent).toEqual([url]);
    await handle.dispose();
    await expect(
      pushSeams.fetchFn(url, { method: "GET" }),
    ).rejects.toMatchObject({ code: "capability-not-approved" });
    expect(sent).toEqual([url]);
    expect(raw).not.toHaveBeenCalled();
  });
});
