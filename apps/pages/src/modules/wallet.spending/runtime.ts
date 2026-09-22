/**
 * `wallet.spending` — budgets, payment methods and spending passes
 * (ADR 0123): the Wallet section with its category rows, the wallet routes,
 * the `g w` jump, and the wallet WebMCP tools (the core filters them by
 * `approvedOperations` before registration).
 *
 * `/wallet/activity` is not registered here: `activity.log` owns that
 * legacy alias and redirects it to `/activity`. When Activity is not
 * approved the path falls through to `/wallet/:category?`, whose unknown
 * category reads as budgets — the redirect to `/wallet` the brief asks for,
 * with no knowledge of another capability's approval needed.
 *
 * Egress: none. The ledger, assignments and passes are browser-local
 * (localStorage scoped by tomb); the agent broker settles in memory.
 * Top-level side effects removed: `lib/spending-ledger.ts`,
 * `lib/spending-leases.ts` and `lib/wallet-assignments.ts` each subscribed
 * to tomb changes at import; each is now a `watch…Scope()` the runtime
 * calls here and unsubscribes on dispose. Every one of those caches is
 * keyed by tomb as well, so a switch nobody observed still misses.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { watchSpendingLeaseScope } from "../../lib/spending-leases.js";
import { watchSpendingLedgerScope } from "../../lib/spending-ledger.js";
import { watchWalletAssignmentScope } from "../../lib/wallet-assignments.js";
import { WalletSection } from "../../sections/WalletSection.js";
import {
  WALLET_ROUTES,
  WALLET_TARGETS,
} from "../../tutorial/registry/wallet-catalog.js";
import { WALLET_TOOLS } from "../../webmcp/wallet-tools.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { WalletTree } from "./WalletTree.js";

export const CAPABILITY = "wallet.spending";

export const TUTORIAL = {
  targets: WALLET_TARGETS,
  routes: WALLET_ROUTES,
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // The wallet's three tomb-scoped caches follow the active tomb only
    // while this capability is active; dispose unsubscribes all three.
    activation.onDispose(watchSpendingLedgerScope());
    activation.onDispose(watchSpendingLeaseScope());
    activation.onDispose(watchWalletAssignmentScope());

    activation.register("section", {
      id: "wallet",
      to: "/wallet",
      label: "Wallet",
      segment: "wallet",
      jump: "w",
      icon: "card",
      order: 50,
      Tree: WalletTree,
    });
    activation.register("route", {
      id: "wallet",
      path: "/wallet/:category?",
      element: WalletSection,
      framed: true,
      order: 50,
    });
    activation.register("command-path", { path: "/wallet", label: "Wallet" });
    activation.register("keymap-jump", { key: "w", path: "/wallet" });
    registerTutorial(activation, TUTORIAL);
    for (const tool of WALLET_TOOLS) {
      activation.register("webmcp-tool", tool);
    }

    return activation.handle();
  },
};
