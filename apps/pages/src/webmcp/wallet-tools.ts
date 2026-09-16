import type { WebMcpToolSpec } from "@opensesame/webmcp";
import {
  formatUnits,
  getSpendingLedger,
  listBudgetRows,
} from "../lib/spending-ledger.js";

type WalletTool = WebMcpToolSpec & {
  capabilityIds: readonly string[];
  scope: "boot" | "session";
};

/**
 * Wallet WebMCP tools (ADR 0123). Read-only ledger/inventory only — never
 * secrets, never spend, never invent settlement or PANs.
 */
export const WALLET_TOOLS: readonly WalletTool[] = [
  {
    name: "opensesame_wallet_capabilities_read",
    capabilityIds: ["wallet.capabilities.read"],
    scope: "boot",
    readOnly: true,
    description:
      "Read the Wallet capability and evidence inventory for this tab: which agent-facing wallet.* operations exist, which are withheld, and that no secret, PAN, root key, or spend action is available here. Never returns payment credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () =>
      ({
        status: "local_inventory",
        productionEnabled: false,
        evidenceStatus: "fixture_verified",
        agentOperations: {
          readable: [
            "wallet.capabilities.read",
            "wallet.budgets.read",
            "wallet.allocations.read",
          ],
          withheldPendingProof: [
            "wallet.payment.propose",
            "wallet.payment.status",
            "wallet.lease.request",
            "wallet.lease.status",
            "wallet.lease.request_stop",
          ],
          excludedUntilDigestBound: ["wallet.payment.execute_approved"],
        },
        refusals: [
          "get_secret",
          "get_card_number",
          "export_private_key",
          "unrestricted_sign",
          "unbounded_paid_fetch",
        ],
        note: "Spending authority is conserved under ADR 0123; this tool invents no budget and settles nothing. Local ledger reads are same-origin only.",
      }) as const,
  },
  {
    name: "opensesame_wallet_budgets_read",
    capabilityIds: ["wallet.budgets.read"],
    scope: "session",
    readOnly: true,
    description:
      "Read conserved local budget projections (ceilings, available, reserved, exposure, posted). Same-origin localStorage ledger only — not cross-device enforcement and not chain settlement.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => {
      const rows = listBudgetRows(getSpendingLedger());
      return {
        status: "local_ledger",
        productionEnabled: false,
        evidenceStatus: "fixture_verified",
        enforcementScope: "same_origin_browser_local",
        settlesOffline: false,
        budgets: rows.map((row) => ({
          nodeId: row.nodeId,
          parentId: row.parentId,
          strategy: row.strategy,
          ceiling: formatUnits(row.ceiling),
          locallyAvailable: formatUnits(row.locallyAvailable),
          reservedToChildren: formatUnits(row.reservedToChildren),
          unresolvedExternalExposure: formatUnits(
            row.unresolvedExternalExposure,
          ),
          postedSpending: formatUnits(row.postedSpending),
        })),
      } as const;
    },
  },
  {
    name: "opensesame_wallet_allocations_read",
    capabilityIds: ["wallet.allocations.read"],
    scope: "session",
    readOnly: true,
    description:
      "Read child allocations and reserved payment attempts from the local conserved ledger. Does not disclose secrets or claim external settlement.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => {
      const ledger = getSpendingLedger();
      const children = listBudgetRows(ledger).filter(
        (row) => row.parentId !== null,
      );
      const attempts = [...ledger.snapshot().attempts.values()];
      return {
        status: "local_ledger",
        productionEnabled: false,
        evidenceStatus: "fixture_verified",
        enforcementScope: "same_origin_browser_local",
        allocations: children.map((row) => ({
          nodeId: row.nodeId,
          parentId: row.parentId,
          strategy: row.strategy,
          ceiling: formatUnits(row.ceiling),
          locallyAvailable: formatUnits(row.locallyAvailable),
          unresolvedExternalExposure: formatUnits(
            row.unresolvedExternalExposure,
          ),
        })),
        attempts: attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          nodeId: attempt.nodeId,
          amount: formatUnits(attempt.amount),
          state: attempt.state,
        })),
      } as const;
    },
  },
];
