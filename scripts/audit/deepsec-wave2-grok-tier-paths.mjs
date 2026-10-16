#!/usr/bin/env node
/**
 * Grok wave-2 priority tiers (subscription rescan order).
 * Tier 1: security-critical surfaces. Tier 2: remainder of core crates/packages.
 * Tier 3: everything else tracked. Tests, generated, fixtures, and docs are excluded.
 */
import path from "node:path";

const SKIP_SEGMENT =
  /(?:^|\/)(?:docs|fixtures?|__tests__|tests|test|generated|mocks?)(?:\/|$)/i;
const SKIP_FILE =
  /\.(?:test|spec)\.[mc]?[jt]sx?$|\.fixture\.[mc]?[jt]sx?$|\.fixtures\.[mc]?[jt]sx?$|\.generated\.[mc]?[jt]sx?$|_test\.rs$|\.md$/i;

/** @param {string} filePath repo-relative */
export function isExcludedFromGrokTiers(filePath) {
  const norm = filePath.replaceAll("\\", "/");
  if (norm.startsWith("docs/")) return true;
  if (norm.startsWith("examples/")) return true;
  if (norm.startsWith("tools/mock")) return true;
  if (SKIP_SEGMENT.test(norm)) return true;
  if (SKIP_FILE.test(path.basename(norm))) return true;
  if (/\/test-support\//i.test(norm)) return true;
  if (/\/conformance\//i.test(norm) && norm.includes("/spec/")) return true;
  return false;
}

function underPrefix(filePath, prefix) {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return filePath === base || filePath.startsWith(`${base}/`);
}

function controlPlaneAuthSlice(filePath) {
  if (!underPrefix(filePath, "packages/control-plane/src")) return false;
  if (underPrefix(filePath, "packages/control-plane/src/routes")) return true;
  if (underPrefix(filePath, "packages/control-plane/src/repos")) return true;
  if (underPrefix(filePath, "packages/control-plane/src/proofs")) return true;
  const svc = filePath.slice("packages/control-plane/src/services/".length);
  if (!filePath.startsWith("packages/control-plane/src/services/"))
    return false;
  return /(?:^|\/)(?:.*auth.*|oauth|mfa|siop|enrollment|authorization|approval|interaction|openid|claims|federated|scim|wallet-registration|host-authorization|ceremony-subject|verified-admin|email-authority|org-email-trust)/i.test(
    svc,
  );
}

const TIER1_PREFIXES = [
  "packages/vault-core",
  "crates/human-vault",
  "packages/app-core/src/lib/vault",
  "packages/app-core/src/lib/at-rest",
  "packages/app-core/src/lib/encrypted-db",
  "crates/gateway",
  "crates/invoke-through",
  "crates/daemon",
  "apps/cli/src/password_agent",
];

function tier1SecurityCritical(filePath) {
  if (controlPlaneAuthSlice(filePath)) return true;
  if (TIER1_PREFIXES.some((p) => underPrefix(filePath, p))) return true;
  const cli = filePath.startsWith("apps/cli/src/")
    ? filePath.slice("apps/cli/src/".length)
    : "";
  return (
    cli !== "" &&
    (/^daemon/.test(cli) || /tailnet/.test(cli) || /^plugins_pair/.test(cli))
  );
}

const CORE_PREFIXES = [
  "crates/",
  "packages/app-core/",
  "packages/vault-core/",
  "packages/vault-item-types/",
  "packages/os-domain/",
  "packages/database/",
  "packages/api-client/",
  "packages/cli/",
  "packages/control-plane/",
  "packages/auth-upstream/",
  "packages/oauth-provider/",
  "packages/claims/",
  "packages/device-auth/",
  "packages/policy/",
  "packages/audit/",
  "packages/contracts/",
  "packages/ceremony-kit/",
  "packages/openid4vp/",
  "packages/openid4vci/",
  "packages/identity-worker/",
  "packages/notification-adapters/",
  "packages/capability-registry/",
  "packages/capability-composition/",
  "packages/agent-protocols/",
  "packages/sdk-server/",
  "packages/sdk-cli/",
  "packages/sdk-browser/",
  "packages/observability/",
  "packages/log-scrub/",
  "packages/ingress-evidence/",
  "packages/wallet/",
  "packages/webmcp/",
  "packages/guide-lang/",
  "packages/guide-runtime/",
  "packages/support-agent/",
  "packages/env-spec-bridge/",
  "packages/testing/",
  "packages/browser-at-rest/",
];

function isCorePackagePath(filePath) {
  return CORE_PREFIXES.some((p) => underPrefix(filePath, p));
}

/** @returns {1|2|3|null} null when excluded from all tiers */
export function grokTierForPath(filePath) {
  if (isExcludedFromGrokTiers(filePath)) return null;
  if (tier1SecurityCritical(filePath)) return 1;
  if (isCorePackagePath(filePath)) return 2;
  return 3;
}

export const GROK_TIER_LABELS = {
  1: "security-critical",
  2: "core-packages",
  3: "remainder",
};
