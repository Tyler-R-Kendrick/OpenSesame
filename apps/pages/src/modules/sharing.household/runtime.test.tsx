/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  NO_SIDE_EFFECTS,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

describe("sharing.household runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers nothing and still hands back a disposable handle (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "sharing.household",
      kinds: [],
      count: 0,
    });
  });
});
