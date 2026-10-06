/** Recovery-code reads and writes belong to the session that authorized them. */
import type { VaultHeader } from "@opensesame/vault-core";
import {
  maskCodeAddress,
  mintRecoveryCodes,
  readRecoveryCodes,
} from "./recovery-codes.js";
import { type CodeChannel, hasSecondStep, openText } from "./unlock-methods.js";
export async function generateSessionRecoveryCodes(
  key: CryptoKey,
  header: VaultHeader,
  assertCurrent: () => void,
  persist: (header: VaultHeader) => Promise<void>,
): Promise<string[]> {
  if (!hasSecondStep(header))
    throw new Error(
      "Recovery codes stand in for a second step. Add an authenticator, email or text code first.",
    );
  const { codes, record } = await mintRecoveryCodes(key);
  assertCurrent();
  await persist({
    ...header,
    unlocks: { ...header.unlocks, recovery: record },
  });
  assertCurrent();
  return codes;
}
export async function readSessionRecoveryCodes(
  key: CryptoKey,
  header: VaultHeader,
  assertCurrent: () => void,
) {
  const record = header.unlocks?.recovery;
  const result = record ? await readRecoveryCodes(key, record) : null;
  assertCurrent();
  return result;
}

export async function describeSessionCodeChannel(
  key: CryptoKey,
  header: VaultHeader,
  channel: CodeChannel,
  assertCurrent: () => void,
): Promise<string | null> {
  const record = header.unlocks?.[channel];
  if (!record) return null;
  const address = await openText(key, record.toWrap);
  assertCurrent();
  return maskCodeAddress(channel, address);
}
