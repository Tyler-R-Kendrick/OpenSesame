import { type JsonObject, isString } from "@opensesame/os-domain";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import {
  formatUnits,
  getSpendingLedger,
  listBudgetRows,
} from "../lib/spending-ledger.js";
import {
  executeApprovedWalletPayment,
  proposeWalletPayment,
  requestWalletLeaseStop,
  walletLeaseStatus,
  walletPaymentStatus,
} from "../lib/wallet-agent-broker.js";

type WalletTool = WebMcpToolSpec & {
  capabilityIds: readonly string[];
  scope: "boot" | "session";
};

const SECRET_REFUSALS = [
  "get_secret",
  "get_card_number",
  "export_private_key",
  "unrestricted_sign",
  "unbounded_paid_fetch",
] as const;

function sessionCaller() {
  return { principalRef: "local-session" };
}

function str(raw: JsonObject, key: string): string {
  const value = raw[key];
  return isString(value) ? value : "";
}

/**
 * Wallet WebMCP tools (ADR 0123). Never secrets, never PAN, never generic
 * sign, never unbounded paid fetch.
 */
export const WALLET_TOOLS: readonly WalletTool[] = [
  {
    name: "opensesame_wallet_capabilities_read",
    capabilityIds: ["wallet.capabilities.read"],
    scope: "boot",
    readOnly: true,
    description:
      "Read the Wallet capability and evidence inventory for this tab. Never returns payment credentials, PANs, or root keys.",
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
            "wallet.payment.status",
            "wallet.lease.status",
          ],
          proposeAndStop: [
            "wallet.payment.propose",
            "wallet.lease.request",
            "wallet.lease.request_stop",
          ],
          executeApprovedOnly: ["wallet.payment.execute_approved"],
        },
        refusals: SECRET_REFUSALS,
        note: "Spending authority is conserved under ADR 0123. execute_approved spends only an internally issued PreparedExecutionRef.",
      }) as const,
  },
  {
    name: "opensesame_wallet_budgets_read",
    capabilityIds: ["wallet.budgets.read"],
    scope: "session",
    readOnly: true,
    description:
      "Read conserved local budget projections. Same-origin only — not chain settlement.",
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
      "Read child allocations and reserved payment attempts from the local conserved ledger.",
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
  {
    name: "opensesame_wallet_payment_propose",
    capabilityIds: ["wallet.payment.propose"],
    scope: "session",
    readOnly: false,
    description:
      "Propose a scoped payment against an existing allocation. Does not settle. Payload identity claims are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        amount: { type: "string" },
        destination: { type: "string" },
        claimedPrincipalRef: { type: "string" },
      },
      required: ["nodeId", "amount", "destination"],
      additionalProperties: false,
    },
    execute: (raw) => {
      const claimed = raw.claimedPrincipalRef;
      return proposeWalletPayment({
        caller: sessionCaller(),
        nodeId: str(raw, "nodeId"),
        amount: str(raw, "amount"),
        destination: str(raw, "destination"),
        claimedPrincipalRef: isString(claimed) ? claimed : undefined,
      });
    },
  },
  {
    name: "opensesame_wallet_payment_execute_approved",
    capabilityIds: ["wallet.payment.execute_approved"],
    scope: "session",
    readOnly: false,
    description:
      "Execute a digest-bound internally issued PreparedExecutionRef. Caller-constructed refs fail. Never a generic sign tool.",
    inputSchema: {
      type: "object",
      properties: {
        preparedRef: { type: "string" },
        singleUseToken: { type: "string" },
      },
      required: ["preparedRef", "singleUseToken"],
      additionalProperties: false,
    },
    execute: (raw) =>
      executeApprovedWalletPayment({
        caller: sessionCaller(),
        preparedRef: str(raw, "preparedRef"),
        singleUseToken: str(raw, "singleUseToken"),
      }),
  },
  {
    name: "opensesame_wallet_payment_status",
    capabilityIds: ["wallet.payment.status"],
    scope: "session",
    readOnly: true,
    description:
      "Read local payment attempt status. Does not invent settlement or disclose secrets.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => walletPaymentStatus(),
  },
  {
    name: "opensesame_wallet_lease_request",
    capabilityIds: ["wallet.lease.request"],
    scope: "session",
    readOnly: false,
    description:
      "Request a spending lease under an existing allocation. Does not mint budget or settle.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        amount: { type: "string" },
        destination: { type: "string" },
      },
      required: ["nodeId", "amount", "destination"],
      additionalProperties: false,
    },
    execute: (raw) =>
      proposeWalletPayment({
        caller: sessionCaller(),
        nodeId: str(raw, "nodeId"),
        amount: str(raw, "amount"),
        destination: str(raw, "destination"),
      }),
  },
  {
    name: "opensesame_wallet_lease_status",
    capabilityIds: ["wallet.lease.status"],
    scope: "session",
    readOnly: true,
    description: "Read spending lease status. Redacted; no secrets.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => walletLeaseStatus(),
  },
  {
    name: "opensesame_wallet_lease_request_stop",
    capabilityIds: ["wallet.lease.request_stop"],
    scope: "session",
    readOnly: false,
    description:
      "Request stop of a spending lease. Does not claim on-chain revocation.",
    inputSchema: {
      type: "object",
      properties: { leaseId: { type: "string" } },
      required: ["leaseId"],
      additionalProperties: false,
    },
    execute: (raw) =>
      requestWalletLeaseStop({
        leaseId: str(raw, "leaseId"),
      }),
  },
];
