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
 * Wallet spending capabilities (ADR 0123). Agent-facing catalog is narrow:
 * inventory, propose, execute_approved (internally issued refs only), status,
 * and lease tools on WebMCP. Headless MCP stays excluded. No get_secret /
 * PAN / root-key surface.
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
      webmcp: "opensesame_wallet_payment_propose",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
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
      webmcp: "opensesame_wallet_payment_execute_approved",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
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
      webmcp: "opensesame_wallet_payment_status",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
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
      webmcp: "opensesame_wallet_lease_request",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
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
      webmcp: "opensesame_wallet_lease_status",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
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
      webmcp: "opensesame_wallet_lease_request_stop",
    },
    excluded: {
      mcp_host: HEADLESS_MCP_WALLET,
      mcp_client: HEADLESS_MCP_WALLET,
    },
  },
];
