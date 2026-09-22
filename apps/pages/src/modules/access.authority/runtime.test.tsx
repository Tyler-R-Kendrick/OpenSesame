/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
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
  "command-path",
  "keymap-jump",
  "route",
  "section",
  "tutorial-goal",
  "tutorial-route",
  "tutorial-target",
];

describe("access.authority runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    expect(runtime.capabilityRuntime.capability).toBe("access.authority");
  });

  it("registers the Access contributions and disposes them (LOAD-09)", async () => {
    const { targets, goals, routes } = runtime.TUTORIAL;
    await expectLifecycle(runtimeOf(runtime), {
      capability: "access.authority",
      kinds: KINDS,
      // 1 section + 3 routes + 1 command + 1 jump + tutorial descriptors
      count: 1 + 3 + 1 + 1 + targets.length + goals.length + routes.length,
    });
  });

  it("names the section (g a, authority, order 30), routes and aliases exactly", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("section").map((s) => [s.id, s.to, s.jump, s.icon, s.order]),
    ).toEqual([["access", "/access", "a", "authority", 30]]);
    expect(t.entries("section")[0]?.Tree).toBeTypeOf("function");
    expect(t.entries("route").map((r) => [r.id, r.path, r.framed, r.gate])).toEqual([
      ["access", "/access/:tab?/:rest?", true, undefined],
      ["agents-alias", "/agents", false, undefined],
      ["sites-alias", "/sites", false, undefined],
    ]);
    expect(t.entries("command-path")).toEqual([
      { path: "/access", label: "Access" },
    ]);
    expect(t.entries("keymap-jump")).toEqual([{ key: "a", path: "/access" }]);
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual([
      ...runtime.TUTORIAL.targets,
    ]);
    expect(t.entries("tutorial-goal").map((d) => d.id)).toEqual([
      ...runtime.TUTORIAL.goals,
    ]);
    expect(t.entries("tutorial-route").map((d) => d.id)).toEqual(["/access"]);
    expect(t.hydrated).toEqual([]);
    await handle.dispose();
  });
});
