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
    const { WALLET_TOOLS } = await import(
      "@opensesame/app-core/webmcp/wallet-tools.js"
    );
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
    expect(
      t.entries("section").map((s) => [s.id, s.to, s.jump, s.icon, s.order]),
    ).toEqual([["wallet", "/wallet", "w", "card", 50]]);
    expect(t.entries("section")[0]?.Tree).toBeTypeOf("function");
    expect(t.entries("route").map((r) => [r.id, r.path, r.framed])).toEqual([
      ["wallet", "/wallet/:category?", true],
    ]);
    expect(t.entries("command-path")).toEqual([
      { path: "/wallet", label: "Wallet" },
    ]);
    expect(t.entries("keymap-jump")).toEqual([{ key: "w", path: "/wallet" }]);
    expect(t.entries("tutorial-target").map((d) => d.id)).toEqual([
      "nav.wallet",
    ]);
    expect(t.entries("tutorial-route").map((d) => d.id)).toEqual(["/wallet"]);
    const tools = t.entries("webmcp-tool").map((tool) => tool.name);
    expect(tools).toContain("opensesame_wallet_budgets_read");
    expect(
      tools.some((name) => /get_secret|get_card|export_private/i.test(name)),
    ).toBe(false);
    await handle.dispose();
  });

  it("subscribes the ledger to tomb changes only while active", async () => {
    const scope = await import(
      "@opensesame/app-core/lib/wallet-storage-scope.js"
    );
    const ledger = await import("@opensesame/app-core/lib/spending-ledger.js");
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

  it("keeps leases and instrument bindings tomb-scoped with the capability disabled", async () => {
    const scope = await import(
      "@opensesame/app-core/lib/wallet-storage-scope.js"
    );
    const leases = await import("@opensesame/app-core/lib/spending-leases.js");
    const assignments = await import(
      "@opensesame/app-core/lib/wallet-assignments.js"
    );

    // Never activated: no listener exists, and the caches must still miss
    // on a tomb switch — suppression is not isolation.
    scope.setWalletStorageTomb("personal");
    leases.clearSpendingLeases();
    assignments.clearInstrumentBudgets();
    assignments.assignInstrumentBudget("item-1", "budget-1");
    expect(assignments.budgetIdForInstrument("item-1")).toBe("budget-1");
    scope.setWalletStorageTomb("project-b");
    expect(assignments.budgetIdForInstrument("item-1")).toBeNull();
    expect(leases.listSpendingLeases()).toEqual([]);

    // Active: the same reads answer from the tomb that is open now.
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    assignments.assignInstrumentBudget("item-2", "budget-2");
    scope.setWalletStorageTomb("personal");
    expect(assignments.budgetIdForInstrument("item-2")).toBeNull();
    expect(assignments.budgetIdForInstrument("item-1")).toBe("budget-1");
    await handle.dispose();

    scope.setWalletStorageTomb("project-b");
    expect(assignments.budgetIdForInstrument("item-1")).toBeNull();
    assignments.clearInstrumentBudgets();
    scope.setWalletStorageTomb("personal");
    assignments.clearInstrumentBudgets();
  });

  it("misses after a switch away and straight back, which a tomb name alone cannot see", async () => {
    const scope = await import(
      "@opensesame/app-core/lib/wallet-storage-scope.js"
    );
    const leases = await import("@opensesame/app-core/lib/spending-leases.js");

    scope.setWalletStorageTomb("personal");
    leases.clearSpendingLeases();
    expect(leases.listSpendingLeases()).toEqual([]);

    // Another context writes the personal tomb's leases while this one is
    // looking at the guest tomb. Coming back must re-read, not answer from
    // the cache the same tomb name filled before the excursion.
    scope.setWalletStorageTomb("guest");
    localStorage.setItem(
      "opensesame.wallet.leases.v1.personal",
      JSON.stringify([
        {
          id: "lease-elsewhere",
          grantRef: "g",
          allocationRef: "a",
          policyVersion: "1",
          beneficiaryRef: "b",
          proofKeyThumbprint: "t",
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-01-02T00:00:00.000Z",
          requiredEnforcementDigest: "d",
          effectiveEnforcementDigest: "d",
          rootAccountingRef: "r",
          status: "active",
          amount: "1",
          currency: "TEST",
          recipient: "b",
          approvalDigest: "d",
          reserveAttemptId: "",
        },
      ]),
    );
    scope.setWalletStorageTomb("personal");
    expect(leases.listSpendingLeases().map((row) => row.id)).toEqual([
      "lease-elsewhere",
    ]);
    leases.clearSpendingLeases();
  });
});
