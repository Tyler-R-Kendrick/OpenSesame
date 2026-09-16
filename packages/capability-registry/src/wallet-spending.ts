import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_WALLET_SPENDING = "0123-wallet-spending-authority.md";

/**
 * Wallet spend authority is conserved leases under ADR 0123. Headless MCP
 * must not become a second spend path beside digest-bound browser consent.
 */
const HEADLESS_MCP_WALLET: CapabilityExclusion = {
  reason:
    "Wallet spending is browser-local with digest-bound human consent (ADR 0123); headless MCP must not propose, execute, lease, or invent budget",
  adr: ADR_WALLET_SPENDING,
};

/**
 * execute_approved may only spend a digest-bound PreparedExecutionRef. Until
 * that binder is wired on a surface, withhold rather than accept caller refs.
 */
const EXECUTE_NEEDS_BINDING: CapabilityExclusion = {
  reason:
    "execute_approved may spend only a digest-bound PreparedExecutionRef; unbound or caller-constructed refs must never move funds",
  adr: ADR_WALLET_SPENDING,
};

/**
 * Status / payment reads that invent settlement stay off WebMCP until receipt
 * adapters exist. Budget/allocation reads are allowed once the Wallet ledger
 * UI exists (same-origin only).
 */
const PAYMENT_STATUS_PENDING_RECEIPTS: CapabilityExclusion = {
  reason:
    "payment.status needs receipt/reconciliation adapters; until those exist a WebMCP tool would invent settlement",
  adr: ADR_WALLET_SPENDING,
};

/**
 * Lease mutation and payment propose stay ceremony-gated on WebMCP until the
 * proof/consent path is registered; capabilities.read remains the inventory.
 */
const SPEND_ACT_PENDING_PROOF: CapabilityExclusion = {
  reason:
    "propose, lease request, and request_stop need digest-bound proof and human consent; withhold agent act tools until that binder is registered rather than accept unbound spend",
  adr: ADR_WALLET_SPENDING,
};

/**
 * Wallet spending capabilities (ADR 0123). Agent-facing catalog is narrow:
 * inventory read may ship as a refuse-or-read-only WebMCP stub; propose may
 * later be agent-facing with proof; execute_approved stays excluded until
 * strict binding exists; no get_secret / PAN / root-key surface.
 */
export const walletSpendingCapabilities: readonly Capability[] = [
  {
    id: "wallet.capabilities.read",
    title: "Read Wallet capability and evidence inventory (never secrets)",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_wallet_capabilities_read",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
    },
  },
  {
    id: "wallet.budgets.read",
    title: "Read Wallet budgets (ceilings, windows, evidence status)",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_wallet_budgets_read",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
    },
  },
  {
    id: "wallet.allocations.read",
    title: "Read Wallet allocations and remaining enforceable authority",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_wallet_allocations_read",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
    },
  },
  {
    id: "wallet.payment.propose",
    title: "Propose a scoped payment (proof-bound; never settles)",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
      webmcp: SPEND_ACT_PENDING_PROOF,
    },
  },
  {
    id: "wallet.payment.execute_approved",
    title: "Execute a digest-bound approved payment reference",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: EXECUTE_NEEDS_BINDING,
      mcp_client: EXECUTE_NEEDS_BINDING,
      webmcp: EXECUTE_NEEDS_BINDING,
    },
  },
  {
    id: "wallet.payment.status",
    title: "Read payment attempt status (pending, settled, failed, unknown)",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
      webmcp: PAYMENT_STATUS_PENDING_RECEIPTS,
    },
  },
  {
    id: "wallet.lease.request",
    title: "Request a spending lease under an existing allocation",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
      webmcp: SPEND_ACT_PENDING_PROOF,
    },
  },
  {
    id: "wallet.lease.status",
    title: "Read spending lease status and remaining authority",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
      webmcp: PAYMENT_STATUS_PENDING_RECEIPTS,
    },
  },
  {
    id: "wallet.lease.request_stop",
    title: "Request stop/revoke of a spending lease",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
      webmcp: SPEND_ACT_PENDING_PROOF,
    },
  },
];
