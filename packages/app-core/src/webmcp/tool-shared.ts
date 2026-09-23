/**
 * Helpers every WebMCP tool group shares: argument readers, the unlocked
 * gate, the ceremony opener, and the support seam. Nothing here names a
 * tool; each group (`boot-tools`, `vault-tools`, `connections-tools`,
 * `identity-tools`, `settings-tools`, `support-tools`, `login-tools`,
 * `wallet-tools`) is contributed by the capability that owns its operations
 * and aggregated for tests in `tools.ts`.
 */

import { type JsonObject, isString } from "@opensesame/os-domain";
import type { VaultItem } from "@opensesame/vault-core";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { vaultStore } from "../lib/vault/store.js";
import { webmcpNavigationSeam } from "./navigation.js";

export type WebMcpSupportSeam = {
  openSupport: (topic: string | null) => void;
  startGuide: (goal: string) => void;
};

/**
 * Support seam: the support panel binds its live open/start functions here
 * while it is mounted, the way the lifecycle hook binds the router. The
 * defaults are silent no-ops so both guidance tools stay callable — and keep
 * rejecting arguments that are not authored ids — in a build that ships no
 * support UI, and in tests that drive them without one.
 */
export const webmcpSupportSeam: WebMcpSupportSeam = {
  openSupport: () => {},
  startGuide: () => {},
};

export type PagesWebMcpTool = WebMcpToolSpec & {
  capabilityIds: readonly string[];
  scope: "boot" | "session";
};

export function str(args: JsonObject, key: string): string {
  const value = args[key];
  if (!isString(value) || value.length === 0) {
    throw new Error(`missing_argument:${key}`);
  }
  return value;
}

export function optStr(args: JsonObject, key: string): string | null {
  const value = args[key];
  return isString(value) && value.length > 0 ? value : null;
}

export function requireUnlocked(): void {
  if (vaultStore.getSnapshot().status !== "unlocked") {
    throw new Error("vault_locked");
  }
}

export function findItem(itemId: string): VaultItem {
  const item = vaultStore
    .getSnapshot()
    .items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`item_not_found:${itemId}`);
  return item;
}

export function ceremonyOpened(location: string) {
  webmcpNavigationSeam.navigate(location);
  return { status: "ceremony_opened", location } as const;
}
