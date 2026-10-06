import type { Capability } from "./index.js";

const FORM_ONLY: Capability["excluded"] = {
  mcp_host: {
    reason: "the account editor is a browser form; headless MCP cannot fill it",
    adr: "0065-agent-surface-parity.md",
  },
  mcp_client: {
    reason: "the account editor is a browser form; headless MCP cannot fill it",
    adr: "0065-agent-surface-parity.md",
  },
};

export const vaultLoginDraftCapabilities: readonly Capability[] = [
  {
    id: "vault.login_draft",
    title:
      "Read and fill the on-screen account editor (metadata only: name, username, sites, method types; never a password, pepper or method secret)",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/vault/login-draft.ts:bindLoginDraft",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_login_draft",
    },
    excluded: FORM_ONLY,
  },
];
