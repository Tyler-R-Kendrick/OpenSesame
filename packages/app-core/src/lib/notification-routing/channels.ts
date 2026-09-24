/**
 * The channels a deployment has, the destinations a person bound, and the
 * route their prompts will actually take — read from the Identity API and
 * put into words (ADR 0084; ADR 0140 plan step 6).
 *
 * What a channel can do comes from one place: os-domain's closed capability
 * record (`channelCapabilities`). The Identity API's listing is read for one
 * fact only — whether an adapter is configured here — and its capability
 * booleans are ignored. A response that claimed a chat channel could satisfy
 * phishing resistance changes nothing on this screen, because nothing here
 * asks the response what a channel can do.
 *
 * Nothing here has a slot for a provider subject id or a provider secret: the
 * subject is the authority-bearing half of a binding, and a screen that shows
 * it back hands anyone reading over a shoulder what a forged callback needs.
 */

import { channelName } from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type ChannelCapabilities,
  type ChannelIneligibilityReason,
  type ChannelInteractionMode,
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
  type NotificationConfidentiality,
  channelCapabilities,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export type ChannelRow = {
  kind: NotificationChannelKind;
  name: string;
  /** Whether this deployment has a working adapter; the inbox always does. */
  configured: boolean;
  /** os-domain's record, never the server's. */
  capabilities: ChannelCapabilities;
  /** Whether a person binds a destination for it (a provider subject). */
  bindable: boolean;
  sentence: string;
};

export type BindingRow = {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  /** Non-authoritative: a display string, never used to resolve anything. */
  label?: string;
  state: string;
  stateSentence: string;
};

export type RouteStepRow = {
  kind: NotificationChannelKind;
  name: string;
  sentence: string;
};

export type EffectiveRoute = {
  steps: RouteStepRow[];
  fanOut: boolean;
  fanOutSentence: string;
  excluded: { kind: NotificationChannelKind; name: string; why: string }[];
};

const MODE_SENTENCES = {
  none: "cannot carry anything",
  notify: "can only tell you something is waiting",
  rendezvous: "can tell you, and link you back here to decide",
  interactive: "can carry the decision itself",
} as const satisfies Record<ChannelInteractionMode, string>;

const CONFIDENTIALITY_SENTENCES = {
  minimal: "shows nothing about what was asked",
  descriptive: "shows a short description",
  full: "shows the whole request",
} as const satisfies Record<NotificationConfidentiality, string>;

const EXCLUSION_SENTENCES = {
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
} as const satisfies Record<ChannelIneligibilityReason, string>;

const STATE_SENTENCES: Readonly<Record<string, string>> = {
  pending: "Waiting to be confirmed — nothing is delivered here yet",
  active: "Active",
  revoked: "Revoked — nothing is delivered here",
  expired: "Expired — nothing is delivered here",
};

/** The standing sentence the notification screen exists to carry. */
export const ASSURANCE_NOTE =
  "Choosing where you're notified doesn't change what it takes to approve. High-risk requests always come back here for a passkey — a message can tell you something is waiting, but it can never be the thing that says yes.";

export const CLASS_LABELS = {
  authorization_request: "Someone asks to use your authority",
  authorization_decision: "A request you sent gets decided",
  security_event: "Something security-relevant happens",
} as const;

function kindOf(value: BoundaryValue): NotificationChannelKind | null {
  return NOTIFICATION_CHANNEL_KINDS.find((kind) => kind === value) ?? null;
}

/** An own entry of a sentence table; a key like `constructor` finds none. */
function lookup(
  table: Readonly<Record<string, string>>,
  key: string,
  fallback: string,
): string {
  return (Object.hasOwn(table, key) ? table[key] : undefined) ?? fallback;
}

export function modeSentence(mode: string): string {
  return lookup(MODE_SENTENCES, mode, mode);
}

export function confidentialitySentence(level: string): string {
  return lookup(CONFIDENTIALITY_SENTENCES, level, level);
}

export function exclusionSentence(reason: string): string {
  return lookup(
    EXCLUSION_SENTENCES,
    reason,
    `Not used: ${reason.replaceAll("_", " ")}.`,
  );
}

export function bindingStateSentence(state: string): string {
  return lookup(STATE_SENTENCES, state, state);
}

/**
 * What a channel can do, in one line. An unconfigured channel says so and
 * nothing else: the capabilities of a channel nobody set up describe a thing
 * that does not exist on this deployment.
 */
export function capabilitySentence(
  capabilities: ChannelCapabilities,
  configured: boolean,
): string {
  if (!configured) {
    return "Not set up on this deployment — nothing would arrive here.";
  }
  const parts: string[] = [
    modeSentence(capabilities.maximumInteractionMode),
    confidentialitySentence(capabilities.confidentiality),
  ];
  if (!capabilities.canSatisfyPhishingResistance) {
    parts.push("can never approve a high-risk request on its own");
  }
  return `${parts.join(", ")}.`;
}

export function channelRow(
  kind: NotificationChannelKind,
  configured: boolean,
): ChannelRow {
  const capabilities = channelCapabilities(kind);
  // The inbox is not an adapter, and is never unconfigured.
  const live = kind === "in_app" || configured;
  return {
    kind,
    name: channelName(kind),
    configured: live,
    capabilities,
    bindable: capabilities.bindsExternalIdentity,
    sentence: capabilitySentence(capabilities, live),
  };
}

/** `GET /v1/notification-channels`: kind and `configured` only. */
export function readChannels(body: BoundaryValue): ChannelRow[] {
  const listed =
    isJsonObject(body) && Array.isArray(body.channels) ? body.channels : [];
  const rows: ChannelRow[] = [];
  for (const entry of listed) {
    if (!isJsonObject(entry)) continue;
    const kind = kindOf(entry.kind);
    if (kind === null || rows.some((row) => row.kind === kind)) continue;
    rows.push(channelRow(kind, entry.configured === true));
  }
  return rows;
}

/** `GET /v1/notification-channels/bindings`, without the subject. */
export function readBindings(body: BoundaryValue): BindingRow[] {
  const listed =
    isJsonObject(body) && Array.isArray(body.bindings) ? body.bindings : [];
  const rows: BindingRow[] = [];
  for (const entry of listed) {
    if (!isJsonObject(entry) || !isString(entry.id)) continue;
    const kind = kindOf(entry.kind);
    if (kind === null) continue;
    const state = isString(entry.state) ? entry.state : "pending";
    rows.push({
      id: entry.id,
      kind,
      name: channelName(kind),
      ...(isString(entry.displayLabel) ? { label: entry.displayLabel } : {}),
      state,
      stateSentence: bindingStateSentence(state),
    });
  }
  return rows;
}

/** `GET /v1/notification-preferences/effective`, put into words. */
export function readEffectiveRoute(body: BoundaryValue): EffectiveRoute {
  const read = isJsonObject(body) ? body : {};
  const steps: RouteStepRow[] = [];
  for (const entry of Array.isArray(read.steps) ? read.steps : []) {
    if (!isJsonObject(entry)) continue;
    const kind = kindOf(entry.kind);
    if (kind === null) continue;
    const mode = isString(entry.mode) ? entry.mode : "none";
    const shown = isString(entry.confidentiality) ? entry.confidentiality : "";
    steps.push({
      kind,
      name: channelName(kind),
      sentence: `${modeSentence(mode)}, and ${confidentialitySentence(shown)}.`,
    });
  }
  const excluded: EffectiveRoute["excluded"] = [];
  for (const entry of Array.isArray(read.excluded) ? read.excluded : []) {
    if (!isJsonObject(entry)) continue;
    const kind = kindOf(entry.kind);
    const reason = isString(entry.reason) ? entry.reason : "";
    if (kind === null) continue;
    excluded.push({
      kind,
      name: channelName(kind),
      why: exclusionSentence(reason),
    });
  }
  const fanOut = read.fanOut === true;
  return {
    steps,
    fanOut,
    fanOutSentence: fanOut
      ? "Every step above is used."
      : "Steps below the first are only tried if the one above fails.",
    excluded,
  };
}
