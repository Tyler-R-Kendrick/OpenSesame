/**
 * View-model logic for `VaultKeyProtectionCeremonies` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { VaultHeader } from "@opensesame/vault-core";
import { setStatusNotice } from "../../lib/notices.js";
import { ProtectionError } from "../../lib/vault/protection/errors.js";
import { selectProtectionView } from "../../lib/vault/protection/protection-view.js";
import {
  type SecondStepId,
  listSecondSteps,
} from "../../lib/vault/unlock-methods.js";

const SECOND_STEP_LABEL = {
  totp: "Authenticator app",
  email: "Email code",
  sms: "Text message",
} satisfies Record<SecondStepId, string>;

/** The key a rotation re-wraps the new vault key under. */
export type RotationKeep = "password" | "passkey" | "pin";

const KEPT_KIND = {
  password: "password",
  passkey: "webauthn-prf",
  pin: "pin",
} as const;

/**
 * Which key a rotation ends on. A vault that holds a master password proves it
 * and keeps it; every other vault gets a new passkey, or a new PIN where the
 * browser cannot make one, and is never given a password (ADR 0180).
 */
export function rotationKeeps(
  header: VaultHeader | null,
  passkeyOk: boolean,
): RotationKeep {
  if (header?.wrap && header.kdf) return "password";
  return passkeyOk ? "passkey" : "pin";
}

/**
 * What rotating the vault key takes with it. A new root keeps one key's wrap
 * (the password's, or the new passkey or PIN that replaces its own kind) and
 * nothing else: every other protector (PIN, passkey, recovery key, age,
 * cloud), the second steps and the recovery codes were sealed or wrapped
 * under the old key and are written off with it. The sheet names them before
 * the key is pressed, and the notice after names the same ones.
 */
export function rotationLosses(
  header: VaultHeader | null,
  keeps: RotationKeep = "password",
): string[] {
  const lost = new Set<string>();
  for (const row of selectProtectionView({ header }).methods) {
    if (row.kind !== KEPT_KIND[keeps]) lost.add(row.mechanismLabel);
  }
  for (const step of listSecondSteps(header)) {
    lost.add(SECOND_STEP_LABEL[step]);
  }
  if (header?.unlocks?.recovery) lost.add("Recovery codes");
  return [...lost];
}

export function status(
  tone: "info" | "warn" | "err",
  title: string,
  body: string,
): void {
  setStatusNotice({ id: "vault-key-protection", tone, title, body });
}

export async function runCaught(
  work: () => Promise<void>,
  fallback: string,
): Promise<void> {
  try {
    await work();
  } catch (caught) {
    if (caught instanceof ProtectionError || caught instanceof Error) {
      status("err", "Vault key protection", caught.message);
      return;
    }
    status("err", "Vault key protection", fallback);
  }
}
