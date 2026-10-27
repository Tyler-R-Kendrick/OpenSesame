import { ADR_PASSWORD_RESET } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * Password reset (ADR 0190): the email accounts a vault keeps for resetting a
 * login, as `email-account` items. The mailbox's login can read mail for every
 * account its address is used on, so setting one up is something a person does
 * in Settings and is withheld from every agent surface. Binding a mailbox to a
 * login is an edit to that login, and rides the account's own operations.
 */
const MAILBOX_LOGIN: CapabilityExclusion = {
  reason:
    "a reset mailbox's login can read the mail that resets every account its address is used on; a surface an agent could drive would let it add, point or replace a person's mailbox, so mailboxes are set up by a person in Settings",
  adr: ADR_PASSWORD_RESET,
};

const CUA_HUMAN_ONLY: CapabilityExclusion = {
  reason:
    "CUA reset drives account recovery, approves per-run authority and may ask the human for a pepper; MCP and WebMCP must not start, configure, approve or reconcile it",
  adr: "0213-cua-password-reset-recipes.md",
};

export const passwordResetCapabilities: readonly Capability[] = [
  {
    id: "password_reset.mailboxes.manage",
    title: "Add, change and remove the email accounts password reset reads",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/password-reset/mailbox-store.ts:addMailbox",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: MAILBOX_LOGIN,
      mcp_client: MAILBOX_LOGIN,
      webmcp: MAILBOX_LOGIN,
    },
  },
  {
    id: "password_reset.cua.run",
    title: "Run and reconcile an approved CUA password reset",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id password-reset run",
      pwa: "route:/password-reset",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: CUA_HUMAN_ONLY,
      mcp_client: CUA_HUMAN_ONLY,
      webmcp: CUA_HUMAN_ONLY,
    },
  },
  {
    id: "password_reset.cua.configure",
    title: "Configure and validate the CUA browser runtime and model",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id password-reset configure",
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: CUA_HUMAN_ONLY,
      mcp_client: CUA_HUMAN_ONLY,
      webmcp: CUA_HUMAN_ONLY,
    },
  },
];
