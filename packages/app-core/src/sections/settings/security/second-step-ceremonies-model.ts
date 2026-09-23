import { remoteIdentityApi } from "../../../lib/identity.js";
/**
 * View-model logic for `SecondStepCeremonies` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { CodeChannel } from "../../../lib/vault/unlock-methods.js";

export function digitsOf(code: string): string {
  return code.replace(/\s/g, "");
}

/* ------------------------------------------------------------------ *
 * Recovery codes — shown once when the first second step turns on, and
 * again from the Recovery row while the vault is open.
 * ------------------------------------------------------------------ */

/** Which codes exist and which are spent. */
export type Codes = { codes: string[]; used: boolean[] };

export function unusedText(ledger: Codes): string {
  return ledger.codes
    .filter((_, i) => !ledger.used[i])
    .join("\n")
    .concat("\n");
}

export function secretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export function looksLikeAddress(channel: CodeChannel, to: string): boolean {
  return channel === "email"
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())
    : /^\+[1-9]\d{6,14}$/.test(to.replace(/[\s()-]/g, ""));
}

export function identityHost(): string {
  try {
    const remote = remoteIdentityApi().trim();
    if (!remote) return "your sign-in service";
    return new URL(remote).host;
  } catch {
    return "your sign-in service";
  }
}
