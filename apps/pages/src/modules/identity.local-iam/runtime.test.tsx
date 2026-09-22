/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import { emitVaultLock } from "../../lib/vault/lock-events.js";
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
  "command-path",
  "keymap-jump",
  "route",
  "section",
  "tutorial-goal",
  "tutorial-route",
  "tutorial-target",
];

describe("identity.local-iam runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetIdentityViewsForTests();
  });

  it("imports with no fetch, timer, DOM, storage or lock-bus side effect", async () => {
    const changes = vi.fn();
    const off = subscribeLocalIamChanges(changes);
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
    // The lock resets that used to subscribe at module load no longer do:
    // a lock right after import reaches no session reset.
    emitVaultLock();
    expect(changes).not.toHaveBeenCalled();
    off();
    expect(runtime.capabilityRuntime.capability).toBe("identity.local-iam");
  });

  it("registers the Identity contributions and disposes them (LOAD-09)", async () => {
    const { targets, goals, routes } = runtime.TUTORIAL;
    await expectLifecycle(runtimeOf(runtime), {
      capability: "identity.local-iam",
      kinds: KINDS,
      count: 1 + 2 + 1 + 1 + targets.length + goals.length + routes.length,
    });
  });

  it("names the section (g i, user, order 40) and both routes exactly", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(
      t.entries("section").map((s) => [s.id, s.to, s.jump, s.icon, s.order]),
    ).toEqual([["identity", "/identity", "i", "user", 40]]);
    expect(t.entries("route").map((r) => [r.id, r.path, r.framed])).toEqual([
      ["identity", "/identity", true],
      ["identity-authorize", "/identity/authorize", true],
    ]);
    expect(t.entries("command-path")).toEqual([
      { path: "/identity", label: "Identity" },
    ]);
    expect(t.entries("keymap-jump")).toEqual([{ key: "i", path: "/identity" }]);
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual([
      "nav.identity",
      "identity.service-accounts",
    ]);
    expect(t.entries("tutorial-route").map((d) => d.id)).toEqual([
      "/identity/authorize",
      "/identity",
    ]);
    await handle.dispose();
  });

  it("puts only the Applications tab on the page, and takes it back on dispose", async () => {
    expect(enabledIdentityViews()).toEqual([]);
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(enabledIdentityViews()).toEqual(["service-accounts"]);
    await handle.dispose();
    expect(enabledIdentityViews()).toEqual([]);
  });

  it("binds the lock resets only while active (no top-level onVaultLock)", async () => {
    // `resetLocalSessions` notifies the local IAM change bus; that is the
    // observable of the lock reset having run.
    const changes = vi.fn();
    const off = subscribeLocalIamChanges(changes);
    emitVaultLock();
    expect(changes).not.toHaveBeenCalled();

    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    emitVaultLock();
    expect(changes).toHaveBeenCalledTimes(1);

    // Disposal resets once more and unbinds: a later lock reaches nothing.
    await handle.dispose();
    expect(changes).toHaveBeenCalledTimes(2);
    emitVaultLock();
    expect(changes).toHaveBeenCalledTimes(2);
    off();
  });
});
