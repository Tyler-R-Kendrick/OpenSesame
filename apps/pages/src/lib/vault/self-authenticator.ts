/**
 * The vault as its own authenticator app (ADR 0113).
 *
 * The enrolled second-step seed is sealed under the vault key, so once a
 * primary method has produced that key, asking a person to retype a code
 * derived from the same key proves nothing — it only trains them to paste
 * one-time codes into whatever asks. When the vault holds its own
 * authenticator entry (`unlocks.totp.selfItemId`), the current code is
 * computed in memory and handed straight to the same `confirmTotp` check a
 * typed code takes: never rendered, never on the clipboard, never through
 * an intent or any other IPC.
 *
 * The entry is an ordinary login item titled "OpenSesame (this vault)", so
 * it works as an authenticator entry in the item list too. Trashing it
 * withdraws the registration — the next unlock asks for the code again —
 * and restoring it reinstates the supply.
 */

import { type VaultHeader, WrongPasswordError } from "./crypto.js";
import { type LoginItem, type VaultBody, createItem } from "./model.js";
import { parseTotp, totpCode, totpSetupUri } from "./totp.js";
import {
  type TotpGateRecord,
  openTotpSecret,
  randomTotpSecret,
  sealTotpSecret,
  totpCodeMatches,
} from "./unlock-methods.js";

export const SELF_AUTHENTICATOR_TITLE = "OpenSesame (this vault)";

const UNGUARDED =
  "Seal this vault with a passkey, PIN or password before adding an authenticator code — a code can only guard a key.";

/** Thrown when a code is asked to guard a vault that has no key. */
export class UnguardedTotpEnrollment extends Error {}

/**
 * Start an enrollment: a fresh seed and its otpauth URI. Nothing is sealed
 * yet — the gate lands only once a code from the seed matches.
 */
export function startTotpEnrollment(
  ephemeral: boolean,
  primaryCount: number,
): { secret: string; uri: string } {
  if (ephemeral || primaryCount === 0) throw new Error(UNGUARDED);
  const secret = randomTotpSecret();
  return {
    secret,
    uri: totpSetupUri(secret, {
      label: "OpenSesame vault",
      issuer: "OpenSesame",
    }),
  };
}

/**
 * Prove the seed was set up, then seal it as the gate. A wrong code leaves
 * everything as it was — enrollment, not an unlock, so no lockout.
 */
export async function proveTotpEnrollment(input: {
  ephemeral: boolean;
  primaryCount: number;
  secret: string | null;
  code: string;
  vaultKey: CryptoKey;
}): Promise<TotpGateRecord> {
  if (!input.secret) {
    throw new Error("Start authenticator enrollment first.");
  }
  if (input.ephemeral || input.primaryCount === 0) {
    throw new UnguardedTotpEnrollment(UNGUARDED);
  }
  const ok = await totpCodeMatches(input.secret, input.code);
  if (!ok) {
    throw new WrongPasswordError(
      "That code did not match. Check the time on your authenticator and try again.",
    );
  }
  return sealTotpSecret(input.vaultKey, input.secret);
}

/**
 * The registration entry for a gate: adopt the live entry with the shared
 * title when one exists (a second device may have sealed it already), else
 * build a fresh one from the gate's seed.
 */
export async function selfAuthenticatorRegistration(
  vaultKey: CryptoKey,
  gate: TotpGateRecord,
  body: VaultBody,
): Promise<{ gate: TotpGateRecord; item: LoginItem | null }> {
  const existing = body.items.find(
    (item): item is LoginItem =>
      item.kind === "login" &&
      item.deletedAt === null &&
      item.name === SELF_AUTHENTICATOR_TITLE &&
      item.totp.length > 0,
  );
  if (existing) {
    return { gate: { ...gate, selfItemId: existing.id }, item: null };
  }
  const secret = await openTotpSecret(vaultKey, gate);
  const item: LoginItem = {
    ...createItem("login", SELF_AUTHENTICATOR_TITLE),
    totp: secret,
  };
  return { gate: { ...gate, selfItemId: item.id }, item };
}

/**
 * Point a gate at its registration and hand back the header to persist plus
 * the entry to seal when one had to be created.
 */
export async function withSelfAuthenticatorRegistration(
  vaultKey: CryptoKey,
  gate: TotpGateRecord,
  header: VaultHeader,
  body: VaultBody,
): Promise<{ header: VaultHeader; item: LoginItem | null }> {
  const registered = await selfAuthenticatorRegistration(vaultKey, gate, body);
  return {
    header: {
      ...header,
      unlocks: { ...header.unlocks, totp: registered.gate },
    },
    item: registered.item,
  };
}

/**
 * The current code from the registered entry, or null when the vault is not
 * its own authenticator right now (no marker, entry trashed, seed unreadable)
 * — the unlock then asks for the code as it always has.
 */
export async function heldTotpCode(
  gate: TotpGateRecord,
  body: VaultBody,
): Promise<string | null> {
  const item = body.items.find(
    (candidate) =>
      candidate.id === gate.selfItemId && candidate.deletedAt === null,
  );
  if (!item || item.kind !== "login" || !item.totp) return null;
  try {
    return await totpCode(parseTotp(item.totp));
  } catch {
    return null;
  }
}
