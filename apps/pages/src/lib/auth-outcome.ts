/**
 * The last sign-in's outcome, surfaced where the person actually lands.
 *
 * The federation return screen navigates straight back to the root, and on a
 * locked vault that root is the unlock screen — which never rendered the
 * notifications bell, so a verified sign-in used to vanish without a word.
 * This record survives that navigation (sessionStorage, same posture as the
 * pending-link marker) and the unlock screen renders it as a banner.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

const OUTCOME_KEY = "opensesame:federation:outcome";

export type AuthOutcome = {
  /**
   * `signed_out` and `attach` are the two roads that arrive here from inside
   * the app: the account menu ended the session (and, when `switching`, is
   * about to start a fresh sign-in), or asked for another account to be
   * attached to the one it has. Either opens the unlock screen on its Sign in
   * tab and says why.
   */
  kind: "linked" | "link_failed" | "error" | "signed_out" | "attach";
  /** Plain-words detail, already user-ready (see federation-copy.ts). */
  detail?: string;
  /** Who signed in, when the leg got far enough to know. */
  who?: string;
  /**
   * A `signed_out` that is the first half of "switch account": the next
   * sign-in must ask the issuer for a fresh login rather than reuse whatever
   * session it still holds (`prompt=login` where the issuer speaks OIDC).
   */
  switching?: boolean;
};

const OUTCOME_KINDS: ReadonlySet<string> = new Set([
  "linked",
  "link_failed",
  "error",
  "signed_out",
  "attach",
]);

function isAuthOutcome(value: BoundaryValue): value is AuthOutcome {
  if (!isJsonObject(value)) return false;
  return typeof value.kind === "string" && OUTCOME_KINDS.has(value.kind);
}

function storeAuthOutcomeDefault(outcome: AuthOutcome): void {
  try {
    // Outcome text only — never tokens. The same information is already on
    // screen the moment it happens; this just survives one navigation.
    // ast-grep-ignore: ts-localstorage-set
    sessionStorage.setItem(OUTCOME_KEY, JSON.stringify(outcome));
  } catch {
    /* private mode — the in-memory render is the only surface then */
  }
}

function readAuthOutcomeDefault(): AuthOutcome | null {
  try {
    const raw = sessionStorage.getItem(OUTCOME_KEY);
    if (!raw) return null;
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isAuthOutcome(parsed)) return null;
    const outcome: AuthOutcome = { kind: parsed.kind };
    if (isString(parsed.detail)) outcome.detail = parsed.detail;
    if (isString(parsed.who)) outcome.who = parsed.who;
    if (parsed.switching === true) outcome.switching = true;
    return outcome;
  } catch {
    return null;
  }
}

function clearAuthOutcomeDefault(): void {
  try {
    sessionStorage.removeItem(OUTCOME_KEY);
  } catch {
    /* nothing was stored */
  }
}

export const authOutcomeSeams = {
  storeAuthOutcome: storeAuthOutcomeDefault,
  readAuthOutcome: readAuthOutcomeDefault,
  clearAuthOutcome: clearAuthOutcomeDefault,
};

export function storeAuthOutcome(outcome: AuthOutcome): void {
  authOutcomeSeams.storeAuthOutcome(outcome);
}

export function readAuthOutcome(): AuthOutcome | null {
  return authOutcomeSeams.readAuthOutcome();
}

export function clearAuthOutcome(): void {
  authOutcomeSeams.clearAuthOutcome();
}

/**
 * True when the last thing that happened asks for the Sign in tab: a sign-out
 * (plain or the first half of a switch), or a request to attach an account.
 */
export function outcomeWantsSignIn(outcome: AuthOutcome | null): boolean {
  return outcome?.kind === "signed_out" || outcome?.kind === "attach";
}

/**
 * True when the next sign-in must ask the issuer for a fresh login rather
 * than silently reuse the session it remembers — the second half of "switch
 * account".
 */
export function outcomeForcesLogin(outcome: AuthOutcome | null): boolean {
  return outcome?.kind === "signed_out" && outcome.switching === true;
}
