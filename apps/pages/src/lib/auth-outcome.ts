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
  kind: "linked" | "pending_link" | "link_failed" | "error";
  /** Plain-words detail, already user-ready (see federation-copy.ts). */
  detail?: string;
  /** Who signed in, when the leg got far enough to know. */
  who?: string;
};

function isAuthOutcome(value: BoundaryValue): value is AuthOutcome {
  if (!isJsonObject(value)) return false;
  return (
    value.kind === "linked" ||
    value.kind === "pending_link" ||
    value.kind === "link_failed" ||
    value.kind === "error"
  );
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
    return {
      kind: parsed.kind,
      ...(isString(parsed.detail) ? { detail: parsed.detail } : {}),
      ...(isString(parsed.who) ? { who: parsed.who } : {}),
    };
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
