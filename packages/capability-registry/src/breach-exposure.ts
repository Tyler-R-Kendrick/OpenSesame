import {
  BREACH_CHECK_TAKES_A_SECRET,
  VAULT_CHECK_READS_PASSWORDS,
} from "./exclusions.js";
import type { Capability } from "./index.js";
import { SCOPED_AGENT_ONLY } from "./lifecycle.js";

/**
 * Host plane: breach exposure (ADR 0080) — what of an organization's secrets
 * has turned up publicly, and vetting a candidate secret before it is stored.
 * And the same question asked in Pages of one person's vault: which logins'
 * passwords are in known breaches, and which sites take a code not stored.
 * Split out of `index` for the 400-line module budget (ADR 0093); every entry
 * is unchanged.
 */
export const breachExposureCapabilities: readonly Capability[] = [
  {
    id: "security.findings.read",
    title: "Read breach findings for this organization",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame security findings",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
    },
  },
  {
    id: "security.breach_scan.trigger",
    title: "Run one breach scan now",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame security scan",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
    },
  },
  {
    id: "security.breach_check.run",
    title: "Check a candidate secret against the breached-password corpus",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame security check",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: BREACH_CHECK_TAKES_A_SECRET,
      webmcp: BREACH_CHECK_TAKES_A_SECRET,
    },
  },
  {
    id: "vault.health.security_check",
    title: "Check the vault's logins against known breaches and two-step sites",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/vault/security-checks.ts:runSecurityChecks",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: VAULT_CHECK_READS_PASSWORDS,
      mcp_host: VAULT_CHECK_READS_PASSWORDS,
      mcp_client: VAULT_CHECK_READS_PASSWORDS,
    },
  },
];
