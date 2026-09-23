/**
 * The complete WebMCP tool catalog, aggregated in registration order for the
 * parity and lifecycle tests and for the legacy `useWebMcp` hook.
 *
 * Runtime registration no longer goes through this list. Each group is
 * contributed as `webmcp-tool` entries by the capability that owns its
 * operations (`boot-tools` by agents.webmcp, `vault-tools` and `login-tools`
 * by the core, `connections-tools` by connectors.external, `identity-tools`
 * by identity.federation, `settings-tools` by support.local-ai,
 * `support-tools` by support.guided-help, `wallet-tools` by wallet.spending),
 * the core keeps only those whose operations the plan approves, and
 * `agents.webmcp`'s background job registers that filtered set with the
 * browser. A capability that is not approved therefore has no tool, and no
 * handler of its is imported by the surface.
 */

import { BOOT_TOOLS } from "./boot-tools.js";
import {
  CONNECTIONS_READ_TOOL,
  OPEN_CONNECT_CEREMONY_TOOL,
} from "./connections-tools.js";
import { IDENTITY_READ_TOOL } from "./identity-tools.js";
import { LOGIN_DRAFT_TOOLS } from "./login-tools.js";
import { SETTINGS_READ_TOOL } from "./settings-tools.js";
import { SUPPORT_TOOLS } from "./support-tools.js";
import type { PagesWebMcpTool } from "./tool-shared.js";
import { OPEN_REVEAL_TOOL, VAULT_TOOLS } from "./vault-tools.js";
import { WALLET_TOOLS } from "./wallet-tools.js";

export { SECTION_PATHS, webmcpNavigationSeam } from "./navigation.js";
export {
  type PagesWebMcpTool,
  type WebMcpSupportSeam,
  webmcpSupportSeam,
} from "./tool-shared.js";
export {
  TOTP_RATE_LIMIT_MS,
  type VaultItemMeta,
  type VaultItemUriMeta,
  projectVaultItemMeta,
  resetTotpRateLimitForTests,
} from "./vault-tools.js";

export const WEBMCP_TOOLS: readonly PagesWebMcpTool[] = [
  ...BOOT_TOOLS,
  ...VAULT_TOOLS,
  CONNECTIONS_READ_TOOL,
  IDENTITY_READ_TOOL,
  SETTINGS_READ_TOOL,
  OPEN_CONNECT_CEREMONY_TOOL,
  OPEN_REVEAL_TOOL,
  ...SUPPORT_TOOLS,
  ...LOGIN_DRAFT_TOOLS,
  ...WALLET_TOOLS,
];
