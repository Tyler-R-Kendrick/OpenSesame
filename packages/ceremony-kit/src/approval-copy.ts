import {
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
} from "@opensesame/os-domain";

/**
 * What an authorization-request review says, with no surface in it (ADR
 * 0084; ADR 0140 plan step 6). Moved out of `apps/ceremonies/src/lib/
 * approvals.ts` so the ceremonies app and Pages read a request the same way.
 *
 * Two rules the wording keeps:
 *   - a reason code or a risk class is never printed raw. `phishing_resistance`
 *     tells a person nothing, and "HIGH" tells them something they cannot
 *     check; each sentence here names a thing that will actually happen;
 *   - a channel only ever *pointed* someone here. Nothing on the screen may
 *     suggest the message that brought them decided anything.
 */

/** One RFC 9396 `authorization_details` entry, as the review reads it. */
export interface AuthorizationDetailView {
  type: string;
  locations?: readonly string[];
  actions?: readonly string[];
  identifier?: string;
}

/**
 * What it will take to settle a request, as the server summarizes it. A
 * projection of the effective policy for a list or a screen, never the gate:
 * settlement re-resolves the policy regardless of what a client did with it.
 */
export interface ApprovalAssurance {
  riskClass?: string;
  requireTransactionBoundActivation: boolean;
  requireComparison: boolean;
  /** Reason codes, not a scalar level. */
  required: readonly string[];
}

/** An own entry of a sentence table; a key like `constructor` finds none. */
function known(
  table: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const REASON_SENTENCES: Readonly<Record<string, string>> = {
  "subject_kind:human":
    "A person has to decide this. An agent cannot approve it on your behalf.",
  "subject_kind:agent": "This is decided by an agent, not by a person.",
  "subject_kind:workload":
    "This is decided by a workload identity, not by a person.",
  user_verification:
    "Your authenticator has to check that it is you — a fingerprint, a face, or a PIN — not just that the device is nearby.",
  phishing_resistance:
    "This asks for access that a typed code could never safely approve, so it needs a passkey bound to this site. Nothing you could copy out of a message counts.",
  verifier_name_binding:
    "The passkey has to be one registered with OpenSesame itself, so an approval made here cannot be replayed against another site.",
  identity_proofing:
    "Your identity has to have been checked to the standard your operator set before this can be approved.",
  device_binding:
    "The key has to live on a device rather than move between them.",
  key_protection:
    "The key has to be held in hardware your browser cannot export.",
  authentication_freshness:
    "You have to have signed in recently. An old session is not enough for this one.",
  acr: "Your sign-in has to have met the authentication level your operator named for this kind of request.",
  transaction_bound_activation:
    "You have to touch your authenticator for this exact request, so a touch you gave to something else cannot be spent here.",
  comparison:
    "You have to type the six-digit code shown where the request started, so the thing you approve is the thing you started.",
};

/** A reason code as a sentence; one the server adds later still reads as one. */
export function requirementSentence(code: string): string {
  return (
    known(REASON_SENTENCES, code) ??
    `Your operator requires "${code.replaceAll("_", " ")}" for this request.`
  );
}

export function requirementSentences(required: readonly string[]): string[] {
  return required.map(requirementSentence);
}

const RISK_SENTENCES: Readonly<Record<string, string>> = {
  low: "This is a routine request. It still needs you, but not extra proof.",
  moderate:
    "This one carries real consequences, so it asks for more than a click.",
  high: "This reaches something sensitive, so approving it takes a fresh, deliberate proof that it is you.",
  critical:
    "This is the most sensitive kind of request there is here. Everything below has to line up before it can go through.",
};

export function riskSentence(riskClass: string): string {
  return (
    known(RISK_SENTENCES, riskClass) ??
    "Your operator has classed this request as needing extra proof."
  );
}

/** How a channel reads inside a sentence ("You got here from …"). */
const CHANNEL_PHRASES = {
  in_app: "the OpenSesame inbox",
  native_push: "a push notification on one of your devices",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  wechat: "WeChat",
  sms: "a text message",
  webhook: "a webhook",
} as const satisfies Record<NotificationChannelKind, string>;

/** How a channel reads as a name in a list ("1. Telegram"). */
export const CHANNEL_NAMES = {
  in_app: "OpenSesame inbox",
  native_push: "Push notification",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  wechat: "WeChat",
  sms: "Text message",
  webhook: "Webhook",
} as const satisfies Record<NotificationChannelKind, string>;

/** A kind os-domain names, or `null`: the one vocabulary for channels. */
export function channelKindOf(value: string): NotificationChannelKind | null {
  return NOTIFICATION_CHANNEL_KINDS.find((kind) => kind === value) ?? null;
}

export function channelLabel(kind: string): string {
  const known = channelKindOf(kind);
  return known ? CHANNEL_PHRASES[known] : kind.replaceAll("_", " ");
}

export function channelName(kind: string): string {
  const known = channelKindOf(kind);
  return known ? CHANNEL_NAMES[known] : kind.replaceAll("_", " ");
}

/** The line a review prints under "You got here from …". */
export function arrivedViaSentence(kind: string): string {
  return `You got here from ${channelLabel(kind)}. That channel only pointed you at this page — nothing about this request was decided there, and nothing about it was sent through it.`;
}

/** What one authorization detail would let someone do, in one line. */
export function describeDetail(detail: AuthorizationDetailView): string {
  const actions = detail.actions?.length ? detail.actions.join(", ") : "use";
  const where = detail.locations?.length
    ? detail.locations.join(", ")
    : (detail.identifier ?? detail.type);
  return `${actions} — ${where}`;
}

/** Whether settling needs the full review: a passkey touch or a code. */
export function needsCeremony(assurance: ApprovalAssurance): boolean {
  return (
    assurance.requireTransactionBoundActivation || assurance.requireComparison
  );
}

/**
 * A short "what this will take" line for a list row, so a person sees before
 * opening anything which requests will ask for their authenticator. `null`
 * is a server that sent no summary: nothing is promised about it.
 */
export function assuranceSummary(assurance: ApprovalAssurance | null): string {
  if (assurance === null) return APPROVAL_WORDS.unknownAssurance;
  const needs: string[] = [];
  if (assurance.requireTransactionBoundActivation) {
    needs.push("a passkey touch for this exact request");
  }
  if (assurance.requireComparison) {
    needs.push("the six-digit code from where it started");
  }
  if (needs.length > 0) return `Needs ${needs.join(" and ")}.`;
  return assurance.required.length > 0
    ? "Needs you signed in as yourself — nothing extra."
    : "Needs your decision — nothing extra.";
}

/** The names of a review's keys, fields and rows, one place for every surface. */
export const APPROVAL_LABELS = {
  title: "Review a request",
  inbox: "Requests for you",
  requester: "Asked by",
  unnamed: "Not named",
  expires: "Good until",
  request: "Request",
  grants: "Would allow",
  requires: "Needs",
  comparison: "Six-digit code from where this started",
  confirm: "I have read what this would do, and I want to allow exactly that.",
  approve: "Approve",
  approveWithPasskey: "Touch your passkey to approve",
  deny: "Deny",
  report: "I don't recognize this request",
  open: "Review request",
  retry: "Try again",
} as const;

/** The fixed sentences of a review, one place for every surface. */
export const APPROVAL_WORDS = {
  /** Why this browser cannot run the ceremony, said rather than skipped. */
  noCredentialsApi:
    "This browser cannot run a passkey ceremony on this page — the credential API is missing, which usually means the page was not loaded over HTTPS, or the browser is too old. This request needs a passkey touch, so it cannot be decided here. Nothing has been approved. Open the same link on a device where passkeys work.",
  comparisonNeeded:
    "Type the six-digit code shown where this request started. It is not sent to you here on purpose — carrying it across is what proves the two are the same request.",
  confirmNeeded:
    "Confirm that you have read what this would do, and that you want to allow exactly that.",
  approved:
    "Approved. Whoever asked can go ahead with exactly what is listed above, and nothing else.",
  denied: "Denied. Nothing was granted, and whoever asked has been told.",
  reportedTitle: "Refused and reported",
  reported:
    "Thanks — this request was refused, and it was recorded as one you did not recognise so your operator can look into where it came from. Nothing was granted, and you do not need to do anything else. If you keep getting links like this one, treat them as phishing and tell whoever runs OpenSesame for you.",
  endedOnLoad: "This request is no longer open",
  endedOnDecide: "This request could not be decided",
  unknownAssurance: "Open it to see what deciding it will take.",
  notRecognized:
    "If you were not expecting this, do not approve it. Use “I don't recognize this request” — that leaves it undecided and tells your operator. Nobody from OpenSesame will ever ask you to read a code back to them.",
  inboxSignIn:
    "These are requests for a specific account, so this page needs you signed in — a guest session has no authority for anyone to ask for.",
} as const;
