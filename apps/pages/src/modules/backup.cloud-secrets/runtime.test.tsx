/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("backup.cloud-secrets runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the SOPS document panel and disposes it (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "backup.cloud-secrets",
      kinds: ["settings-panel"],
      count: 1,
    });
  });

  it("draws the SOPS document row under Security, reachable by a guest", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const record = t.registered.find(
      (entry) => entry.kind === "settings-panel",
    );
    expect(record?.entry).toBe(runtime.SOPS_DOCUMENT_PANEL);
    expect(runtime.SOPS_DOCUMENT_PANEL).toMatchObject({
      id: "sops-document",
      category: "security",
    });
    await handle.dispose();
    expect(t.liveKinds()).not.toContain("settings-panel");
  });

  it("touches no KMS protector and reaches no network", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.egressCalls).toEqual([]);
    expect(t.hydrated).toEqual([]);
    await handle.dispose();
  });
});
