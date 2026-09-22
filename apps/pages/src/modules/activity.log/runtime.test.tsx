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

describe("activity.log runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the activity section, routes, jump and target (LOAD-09)", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "activity.log",
      kinds: [
        "command-path",
        "keymap-jump",
        "route",
        "section",
        "tutorial-route",
        "tutorial-target",
      ],
      count: 1 + 1 + 2 + 1 + 1 + 1,
    });
  });

  it("names the entries exactly, including the /wallet/activity alias", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("section").map((s) => [s.id, s.to, s.jump, s.icon, s.order]),
    ).toEqual([["activity", "/activity", "y", "clock", 60]]);
    expect(t.entries("route").map((r) => [r.id, r.path, r.framed])).toEqual([
      ["activity", "/activity", true],
      ["wallet-activity-alias", "/wallet/activity", false],
    ]);
    expect(t.entries("command-path")).toEqual([
      { path: "/activity", label: "Activity" },
    ]);
    expect(t.entries("keymap-jump")).toEqual([{ key: "y", path: "/activity" }]);
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual([
      "nav.activity",
    ]);
    expect(t.entries("tutorial-route").map((d) => d.id)).toEqual(["/activity"]);
    await handle.dispose();
  });
});
