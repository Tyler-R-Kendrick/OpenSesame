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

const SECOND_STEP_LABEL: Record<SecondStepId, string> = {
  totp: "Authenticator app",
  email: "Email code",
  sms: "Text message",
};

/**
 * What rotating the vault key takes with it. A new root keeps the password's
 * wrap and nothing else: every other protector (PIN, passkey, recovery key,
 * age, cloud), the second steps and the recovery codes were sealed or wrapped
 * under the old key and are written off with it. The sheet names them before
 * the key is pressed, and the notice after names the same ones.
 */
export function rotationLosses(header: VaultHeader | null): string[] {
  const lost = new Set<string>();
  for (const row of selectProtectionView({ header }).methods) {
    if (row.kind !== "password") lost.add(row.mechanismLabel);
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
