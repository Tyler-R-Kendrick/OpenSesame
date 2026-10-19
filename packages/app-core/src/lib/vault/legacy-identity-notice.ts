/**
 * One-time notice for a vault that still approves Self-issued OpenID or
 * Ambient single sign-on after fresh installs stopped enabling them.
 *
 * The decision does not change the plan. Turning either capability off is a
 * separate, explicit consent commit — the same one Settings › Features uses.
 * The seen marker lives in sealed vault prefs (`legacyIdentityNoticeSeen`).
 */

import type {
  CapabilityCatalog,
  CapabilityId,
  EffectivePlan,
} from "@opensesame/capability-composition";
import {
  type FeatureProposal,
  featureById,
  switchCapability,
} from "../capabilities/features.js";

export const LEGACY_IDENTITY_CAPABILITIES = [
  "identity.siop",
  "identity.ambient-sso",
] as const satisfies readonly CapabilityId[];

export type LegacyIdentityCapability =
  (typeof LEGACY_IDENTITY_CAPABILITIES)[number];

/** Catalog titles, so the sentence names the Features tiles. */
export const LEGACY_IDENTITY_TITLES = {
  "identity.siop": "Self-issued OpenID",
  "identity.ambient-sso": "Ambient single sign-on",
} as const satisfies Record<LegacyIdentityCapability, string>;

/** Identity section on Settings › Features. */
export const LEGACY_IDENTITY_FEATURES_PATH =
  "/settings/features#feature-identity";

export const LEGACY_IDENTITY_NOTICE_ID = "vault:legacy-identity-features";

export const LEGACY_IDENTITY_SAVE_FAILURE_ID =
  "vault:legacy-identity-features:save";

export const LEGACY_IDENTITY_OFF_FAILURE_ID =
  "vault:legacy-identity-features:off";

export const LEGACY_IDENTITY_RELOAD_NOTICE_ID = "vault:legacy-identity-reload";

export const LEGACY_IDENTITY_SAVE_FAILURE =
  "Could not save that this notice was shown.";

export const LEGACY_IDENTITY_OFF_FAILURE = "Could not turn these off.";

export const LEGACY_IDENTITY_RELOAD_BODY =
  "Reload to finish turning these off.";

export type LegacyIdentityNoticeDecision = Readonly<{
  id: typeof LEGACY_IDENTITY_NOTICE_ID;
  tone: "info";
  title: string;
  body: string;
  open: { readonly to: string; readonly label: string };
  enabled: readonly LegacyIdentityCapability[];
}>;

function subject(enabled: readonly LegacyIdentityCapability[]): string {
  const names = enabled.map((id) => LEGACY_IDENTITY_TITLES[id]);
  const first = names[0] ?? "";
  const second = names[1];
  if (second === undefined) return first;
  return `${first} and ${second}`;
}

function bodyFor(enabled: readonly LegacyIdentityCapability[]): string {
  const named = subject(enabled);
  if (enabled.length > 1) {
    return `${named} are on. Turn them off in Settings › Features.`;
  }
  return `${named} is on. Turn it off in Settings › Features.`;
}

export type LegacyIdentityNoticeQuery = Readonly<{
  approved: readonly string[];
  seen: boolean;
}>;

/**
 * The notice to show, or null when neither capability is approved or this
 * vault has already been told. `approved` is the effective plan's approved
 * set — a fresh install's defaults are not enough on their own.
 */
export function legacyIdentityNotice(
  input: LegacyIdentityNoticeQuery,
): LegacyIdentityNoticeDecision | null {
  if (input.seen) return null;
  const enabled = LEGACY_IDENTITY_CAPABILITIES.filter((id) =>
    input.approved.includes(id),
  );
  if (enabled.length === 0) return null;
  return {
    id: LEGACY_IDENTITY_NOTICE_ID,
    tone: "info",
    title: "Identity",
    body: bodyFor(enabled),
    open: { to: LEGACY_IDENTITY_FEATURES_PATH, label: "Features" },
    enabled,
  };
}

/**
 * The installation selection after those capabilities are switched off.
 * Same proposal the Features tiles commit. Does not commit it.
 */
export function legacyIdentityTurnOffProposal(
  current: FeatureProposal,
  enabled: readonly LegacyIdentityCapability[],
  plan: EffectivePlan | null,
  catalog: CapabilityCatalog,
): FeatureProposal {
  const feature = featureById("identity");
  let next = current;
  for (const id of enabled) {
    next = switchCapability(next, feature, id, false, plan, catalog);
  }
  return next;
}

export type LegacyIdentityRaiseInput = Readonly<{
  status: string;
  guest: boolean;
  tomb: string;
  seen: boolean;
  /** The approved plan has resolved. A settling plan must not be judged. */
  ready: boolean;
  approved: readonly string[];
}>;

export type LegacyIdentityRaisePorts = Readonly<{
  markSeen: () => Promise<void>;
  announce: (notice: LegacyIdentityNoticeDecision) => void;
  fail: (message: string) => void;
}>;

const announced = new Set<string>();

/** Test-only: forget which tombs already raised the notice this session. */
export function resetLegacyIdentityNoticeForTest(): void {
  announced.clear();
}

/**
 * Show the notice at most once per tomb this session, then seal the marker.
 * A guest session is skipped: its tomb does not keep prefs. A plan that is
 * not ready is skipped so an empty approval cannot count as "off".
 */
export function raiseLegacyIdentityNotice(
  input: LegacyIdentityRaiseInput,
  ports: LegacyIdentityRaisePorts,
): void {
  if (input.status !== "unlocked" || input.guest || !input.ready) return;
  if (announced.has(input.tomb)) return;
  const notice = legacyIdentityNotice({
    approved: input.approved,
    seen: input.seen,
  });
  if (!notice) return;
  announced.add(input.tomb);
  ports.announce(notice);
  void ports.markSeen().catch(() => {
    ports.fail(LEGACY_IDENTITY_SAVE_FAILURE);
  });
}
