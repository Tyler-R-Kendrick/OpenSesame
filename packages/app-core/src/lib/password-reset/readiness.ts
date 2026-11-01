/**
 * Whether the device can start an agent-driven password reset from the vault.
 * Value-blind: capability approval, a saved computer-use runtime, and a model
 * plane the autonomous ceremony can use.
 */

import { listConnections } from "../connections.js";
import { catalogProvider } from "../connector-catalog.js";
import { getBundledProviders } from "../embedded-catalog.js";
import {
  type ResolvedModelPlane,
  autonomousResetAvailable,
} from "../model-provider.js";

export type PasswordResetReadiness =
  | { ok: true }
  | {
      ok: false;
      reason: "feature-off" | "runtime" | "model";
    };

export function passwordResetFeatureApproved(
  approvedCapabilities: readonly string[] | undefined,
): boolean {
  return approvedCapabilities?.includes("ai.password-reset") === true;
}

export async function passwordResetRuntimeConfigured(): Promise<boolean> {
  // The anonymous Cloudflare/Vercel relays are configured by default:
  // they need no vendor account, no claim, and no saved connection.
  const anonymousReady = getBundledProviders().some(
    (provider) =>
      provider.category === "cua_runtime" &&
      provider.configured &&
      provider.autoConfigurable,
  );
  if (anonymousReady) return true;
  const rows = await listConnections();
  return rows.some((row) => {
    const provider = catalogProvider(row.providerId);
    return provider?.category === "cua_runtime";
  });
}

export function passwordResetModelReady(plane: ResolvedModelPlane): boolean {
  return autonomousResetAvailable(plane);
}

export async function evaluatePasswordResetReadiness(
  approvedCapabilities: readonly string[] | undefined,
  plane: ResolvedModelPlane,
): Promise<PasswordResetReadiness> {
  if (!passwordResetFeatureApproved(approvedCapabilities)) {
    return { ok: false, reason: "feature-off" };
  }
  if (!(await passwordResetRuntimeConfigured())) {
    return { ok: false, reason: "runtime" };
  }
  if (!passwordResetModelReady(plane)) {
    return { ok: false, reason: "model" };
  }
  return { ok: true };
}
