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
 * Top-level side effect removed: `lib/spending-ledger.ts` subscribed to
 * tomb changes at import; it is now `watchSpendingLedgerScope()`, called
 * here and unsubscribed on dispose.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { watchSpendingLedgerScope } from "../../lib/spending-ledger.js";
import { WalletSection } from "../../sections/WalletSection.js";
import { WALLET_TOOLS } from "../../webmcp/wallet-tools.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { WalletTree } from "./WalletTree.js";

export const CAPABILITY = "wallet.spending";

export const TUTORIAL = {
  targets: ["nav.wallet"],
  routes: ["/wallet"],
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.onDispose(watchSpendingLedgerScope());

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
