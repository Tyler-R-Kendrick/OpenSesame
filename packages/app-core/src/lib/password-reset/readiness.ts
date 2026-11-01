/**
 * Whether the device can start an agent-driven password reset from the vault.
 * Value-blind: capability approval, a computer-use runtime the person has
 * not switched off, and a model plane the autonomous ceremony can use.
 */

import { type Connection, listConnections } from "../connections.js";
import { catalogProvider } from "../connector-catalog.js";
import {
  type ConnectorSetting,
  connectionSettingKey,
  readConnectorSettings,
  settingFor,
} from "../connector-settings.js";
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

export async function passwordResetRuntimeConfigured(
  tomb?: string | null,
): Promise<boolean> {
  // "Enabled by default" is only the starting state: a runtime the
  // person switched off in connector settings — provider-wide or on
  // its saved connection row — does not count. Sealed settings that
  // cannot be read fail closed: the off switch must not be skippable
  // by making it unreadable.
  let settings: Record<string, ConnectorSetting> = {};
  if (tomb) {
    try {
      settings = await readConnectorSettings(tomb);
    } catch {
      return false;
    }
  }
  const providerOff = (providerId: string) =>
    !settingFor(settings, providerId).enabled;
  const rowOff = (row: Connection) =>
    !settingFor(settings, connectionSettingKey(row.connectionId)).enabled;
  // A connection list that cannot be read (an unrelated Connect
  // transport outage) must not escape as a rejection or veto the
  // anonymous defaults below; it only forfeits saved-runtime credit.
  const listed = await listConnections().catch(() => [] as Connection[]);
  const saved = listed.filter(
    (row) =>
      row.status !== "revoked" &&
      catalogProvider(row.providerId)?.category === "cua_runtime",
  );
  if (saved.some((row) => !providerOff(row.providerId) && !rowOff(row)))
    return true;
  // The anonymous Cloudflare/Vercel relays need no vendor account, no
  // claim, and no saved connection — but a disabled saved row for one
  // is the person switching that runtime off, default or not.
  return getBundledProviders().some(
    (provider) =>
      provider.category === "cua_runtime" &&
      provider.configured &&
      provider.autoConfigurable &&
      !providerOff(provider.id) &&
      !saved.some((row) => row.providerId === provider.id && rowOff(row)),
  );
}

export function passwordResetModelReady(plane: ResolvedModelPlane): boolean {
  return autonomousResetAvailable(plane);
}

export async function evaluatePasswordResetReadiness(
  approvedCapabilities: readonly string[] | undefined,
  plane: ResolvedModelPlane,
  tomb?: string | null,
): Promise<PasswordResetReadiness> {
  if (!passwordResetFeatureApproved(approvedCapabilities)) {
    return { ok: false, reason: "feature-off" };
  }
  if (!(await passwordResetRuntimeConfigured(tomb))) {
    return { ok: false, reason: "runtime" };
  }
  if (!passwordResetModelReady(plane)) {
    return { ok: false, reason: "model" };
  }
  return { ok: true };
}
