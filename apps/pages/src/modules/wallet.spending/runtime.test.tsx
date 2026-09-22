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

describe("wallet.spending runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the wallet section, route, jump, tutorial and tools (LOAD-09)", async () => {
    const { WALLET_TOOLS } = await import("../../webmcp/wallet-tools.js");
    await expectLifecycle(runtimeOf(runtime), {
      capability: "wallet.spending",
      kinds: [
        "command-path",
        "keymap-jump",
        "route",
        "section",
        "tutorial-route",
        "tutorial-target",
        "webmcp-tool",
      ],
      count: 1 + 1 + 1 + 1 + 1 + 1 + WALLET_TOOLS.length,
    });
  });

  it("names the entries exactly and leaves /wallet/activity to activity.log", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("section").map((s) => [s.id, s.to, s.jump, s.icon, s.order])).toEqual([
      ["wallet", "/wallet", "w", "card", 50],
    ]);
    expect(t.entries("section")[0]?.Tree).toBeTypeOf("function");
    expect(t.entries("route").map((r) => [r.id, r.path, r.framed])).toEqual([
      ["wallet", "/wallet/:category?", true],
    ]);
    expect(t.entries("command-path")).toEqual([{ path: "/wallet", label: "Wallet" }]);
    expect(t.entries("keymap-jump")).toEqual([{ key: "w", path: "/wallet" }]);
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual(["nav.wallet"]);
    expect(t.entries("tutorial-route").map((d) => d.id)).toEqual(["/wallet"]);
    const tools = t.entries("webmcp-tool").map((tool) => tool.name);
    expect(tools).toContain("opensesame_wallet_budgets_read");
    expect(tools.some((name) => /get_secret|get_card|export_private/i.test(name))).toBe(false);
    await handle.dispose();
  });

  it("subscribes the ledger to tomb changes only while active", async () => {
    const scope = await import("../../lib/wallet-storage-scope.js");
    const ledger = await import("../../lib/spending-ledger.js");
    scope.setWalletStorageTomb("personal");
    const first = ledger.getSpendingLedger();
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    scope.setWalletStorageTomb("project-a");
    expect(ledger.getSpendingLedger()).not.toBe(first);
    await handle.dispose();
    // After dispose the listener is gone; the tomb-keyed cache still misses.
    const a = ledger.getSpendingLedger();
    scope.setWalletStorageTomb("personal");
    expect(ledger.getSpendingLedger()).not.toBe(a);
  });
});
