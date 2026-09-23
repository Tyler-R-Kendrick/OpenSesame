/**
 * View-model logic for `VaultKeyProtectionCeremonies` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import { setStatusNotice } from "../../lib/notices.js";
import { ProtectionError } from "../../lib/vault/protection/errors.js";

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
