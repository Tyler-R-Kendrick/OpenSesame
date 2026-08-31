import { overlapCast } from "@opensesame/os-domain";
import { type ChannelKind, identityCall } from "./approvals.js";

/**
 * Notification channels, bindings and preferences — the honest settings layer
 * (ADR 0081).
 *
 * The screen this feeds has one job beyond listing things: it has to be
 * truthful about what will actually happen. Two habits carry that:
 *
 * - An unconfigured channel is never dressed up as a working one. `configured`
 *   comes from the server, and the screen says "no adapter is set up" rather
 *   than offering a toggle that does nothing.
 * - The *effective* route is fetched separately from the preference, and its
 *   exclusions are rendered. A settings page that shows only what a person
 *   asked for, and not which of those the server threw away, is a page that
 *   lies quietly.
 *
 * Nothing here reads a provider secret or a provider subject id. The subject
 * is the authority-bearing half of a binding; the wire contract omits it, and
 * this module keeps no field to put it in.
 */

export type NotificationClass =
  | "authorization_request"
  | "authorization_decision"
  | "security_event";

export const NOTIFICATION_CLASSES: readonly NotificationClass[] = [
  "authorization_request",
  "authorization_decision",
  "security_event",
];

export type BindingState = "pending" | "active" | "revoked" | "expired";

/** Mirrors `ChannelCapabilitiesResponseSchema`. */
export interface ChannelCapabilitiesView {
  kind: ChannelKind;
  canNotify: boolean;
  canRendezvous: boolean;
  canReceiveAuthenticatedCallback: boolean;
  canRenderDecisionActions: boolean;
  bindsExternalIdentity: boolean;
  bindsProviderTenant: boolean;
  supportsUserVerification: boolean;
  supportsTransactionBinding: boolean;
  canSatisfyPhishingResistance: boolean;
  maximumInteractionMode: "none" | "notify" | "rendezvous" | "interactive";
  confidentiality: "minimal" | "descriptive" | "full";
  configured: boolean;
}

/** Mirrors `ChannelBindingResponseSchema` — note the absent subject id. */
export interface ChannelBindingView {
  id: string;
  kind: ChannelKind;
  providerId: string;
  displayLabel?: string;
  state: BindingState;
  verification: string;
  createdAt: string;
  verifiedAt?: string;
  revokedAt?: string;
}

export interface PreferenceView {
  channels: ChannelKind[];
  fanOut: boolean;
}

export type PreferencesByClass = {
  [cls in NotificationClass]?: PreferenceView;
};

export type ExclusionReason =
  | "not_allowed_by_policy"
  | "no_active_binding"
  | "adapter_unavailable"
  | "cannot_notify"
  | "not_preferred";

/** Mirrors `EffectiveRouteResponseSchema`. */
export interface EffectiveRouteView {
  steps: {
    kind: ChannelKind;
    mode: "none" | "notify" | "rendezvous" | "interactive";
    confidentiality: "minimal" | "descriptive" | "full";
  }[];
  fanOut: boolean;
  excluded: { kind: ChannelKind; reason: ExclusionReason }[];
}

/** Mirrors `BeginChannelBindingResponseSchema`. Returned once, never stored. */
export interface BeginBindingView {
  challengeId: string;
  nonce: string;
  expiresAt: string;
  authorizeUrl?: string;
}

/* ------------------------------------------------------------------ *
 * Reads and writes
 * ------------------------------------------------------------------ */

export async function listChannels(): Promise<ChannelCapabilitiesView[]> {
  const body = await identityCall("/v1/notification-channels");
  const channels = body.channels;
  return Array.isArray(channels) ? overlapCast(channels) : [];
}

export async function listBindings(): Promise<ChannelBindingView[]> {
  const body = await identityCall("/v1/notification-channels/bindings");
  const bindings = body.bindings;
  return Array.isArray(bindings) ? overlapCast(bindings) : [];
}

export async function beginBinding(
  kind: ChannelKind,
  displayLabel: string,
): Promise<BeginBindingView> {
  const label = displayLabel.trim();
  const body = await identityCall("/v1/notification-channels/bindings", {
    method: "POST",
    body: JSON.stringify({
      kind,
      ...(label ? { displayLabel: label } : undefined),
    }),
  });
  return overlapCast(body);
}

export async function revokeBinding(id: string): Promise<void> {
  await identityCall(
    `/v1/notification-channels/bindings/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function loadPreferences(): Promise<PreferencesByClass> {
  const body = await identityCall("/v1/notification-preferences");
  const byClass = body.byClass;
  return byClass ? overlapCast(byClass) : {};
}

export async function savePreferences(
  byClass: PreferencesByClass,
): Promise<void> {
  await identityCall("/v1/notification-preferences", {
    method: "PUT",
    body: JSON.stringify({ byClass }),
  });
}

export async function loadEffectiveRoute(
  cls: NotificationClass,
): Promise<EffectiveRouteView> {
  const body = await identityCall(
    `/v1/notification-preferences/effective?class=${encodeURIComponent(cls)}`,
  );
  return overlapCast(body);
}

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

/**
 * The one piece of copy this whole screen exists to carry.
 *
 * Everything else on the page is a preference. This sentence is the reason a
 * preference is safe to offer at all: choosing a destination narrows where a
 * person is interrupted and cannot widen who may approve. If a reader takes
 * away only one thing, it has to be this, so it sits at the top and is not
 * collapsible, dismissible, or phrased as a caveat.
 */
export const ASSURANCE_NOTE =
  "Choosing where you're notified doesn't change what it takes to approve. High-risk requests always come back here for a passkey — a message can tell you something is waiting, but it can never be the thing that says yes.";

const CLASS_LABELS = new Map<string, string>(
  Object.entries({
    authorization_request: "Someone asks to use your authority",
    authorization_decision: "A request you sent gets decided",
    security_event: "Something security-relevant happens",
  }),
);

export function classLabel(cls: NotificationClass): string {
  return CLASS_LABELS.get(cls) ?? cls;
}

const CHANNEL_NAMES = new Map<string, string>(
  Object.entries({
    in_app: "OpenSesame inbox",
    native_push: "Push notification",
    slack: "Slack",
    teams: "Microsoft Teams",
    telegram: "Telegram",
    wechat: "WeChat",
    sms: "Text message",
    webhook: "Webhook",
  }),
);

export function channelName(kind: string): string {
  return CHANNEL_NAMES.get(kind) ?? kind.replaceAll("_", " ");
}

const EXCLUSION_SENTENCES = new Map<string, string>(
  Object.entries({
    not_allowed_by_policy:
      "Your operator's policy does not allow this kind of prompt to go here, so your preference for it is ignored.",
    no_active_binding:
      "You have not connected a destination for this yet, so there is nowhere to send it.",
    adapter_unavailable:
      "This deployment has no working adapter for this channel, so nothing would arrive.",
    cannot_notify:
      "This channel cannot put a message in front of a person, so it is never used to reach you.",
    not_preferred:
      "Allowed, but you have not put it in your order, so it is not used.",
  }),
);

export function exclusionSentence(reason: string): string {
  return (
    EXCLUSION_SENTENCES.get(reason) ??
    `Not used: ${reason.replaceAll("_", " ")}.`
  );
}

const MODE_SENTENCES = new Map<string, string>(
  Object.entries({
    none: "cannot carry anything",
    notify: "can only tell you something is waiting",
    rendezvous: "can tell you, and link you back here to decide",
    interactive: "can carry the decision itself",
  }),
);

export function modeSentence(mode: string): string {
  return MODE_SENTENCES.get(mode) ?? mode;
}

const CONFIDENTIALITY_SENTENCES = new Map<string, string>(
  Object.entries({
    minimal: "shows nothing about what was asked",
    descriptive: "shows a short description",
    full: "shows the whole request",
  }),
);

export function confidentialitySentence(level: string): string {
  return CONFIDENTIALITY_SENTENCES.get(level) ?? level;
}

const STATE_SENTENCES = new Map<string, string>(
  Object.entries({
    pending: "Waiting to be confirmed — nothing is delivered here yet",
    active: "Active",
    revoked: "Revoked — nothing is delivered here",
    expired: "Expired — nothing is delivered here",
  }),
);

export function bindingStateSentence(state: string): string {
  return STATE_SENTENCES.get(state) ?? state;
}

/**
 * What this channel is capable of, in one line.
 *
 * An unconfigured channel says so first and says nothing else, because the
 * capability list of a channel nobody set up is a description of a thing that
 * does not exist on this deployment.
 */
export function capabilitySentence(channel: ChannelCapabilitiesView): string {
  if (!channel.configured) {
    return "Not set up on this deployment — nothing would arrive here.";
  }
  const parts = [modeSentence(channel.maximumInteractionMode)];
  parts.push(confidentialitySentence(channel.confidentiality));
  if (!channel.canSatisfyPhishingResistance) {
    parts.push("can never approve a high-risk request on its own");
  }
  return `${parts.join(", ")}.`;
}

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

/**
 * Move one entry up or down.
 *
 * Pure, so the reorder buttons are the only thing the screen has to get
 * right, and returns the same array when nothing moved so a caller can skip a
 * needless save.
 */
export function reorder(
  channels: readonly ChannelKind[],
  index: number,
  direction: -1 | 1,
): ChannelKind[] {
  const next = [...channels];
  const target = index + direction;
  const a = next[index];
  const b = next[target];
  if (a === undefined || b === undefined) return next;
  next[index] = b;
  next[target] = a;
  return next;
}
