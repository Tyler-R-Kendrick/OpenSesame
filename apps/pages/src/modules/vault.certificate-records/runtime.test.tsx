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

describe("vault.certificate-records runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers only the certificate item kind (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.certificate-records",
      kinds: ["item-kind"],
      count: 1,
    });
  });

  it("names the kind exactly", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("item-kind").map((k) => [k.kind, k.label, k.segment, k.order]),
    ).toEqual([["certificate", "Certificates", "certs", 70]]);
    expect(t.entries("item-kind")[0]?.Icon).toBeTypeOf("function");
    await handle.dispose();
  });
});
