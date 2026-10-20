/** Second-step enrollment and recovery; the Store keeps every secret and publication owner. */
import type { VaultHeader } from "@opensesame/vault-core";
import {
  maskCodeAddress,
  mintRecoveryCodes,
  readRecoveryCodes,
} from "./recovery-codes.js";
import { type SentCode, sendCode, verifyCode } from "./remote-code.js";
import { headerWithoutSecondStep } from "./second-step-removal.js";
import {
  UnguardedTotpEnrollment,
  proveTotpEnrollment,
  startTotpEnrollment,
} from "./self-authenticator.js";
import {
  type CodeChannel,
  type TotpGateRecord,
  type VaultUnlocks,
  hasSecondStep,
  openText,
  primaryUnlockCount,
  sealText,
} from "./unlock-methods.js";
type CodeAddress = { channel: CodeChannel; to: string };
type SecondStepHost = Readonly<{
  requireUnlocked: () => { vaultKey: CryptoKey; header: VaultHeader };
  ephemeral: () => boolean;
  totpSecret: () => string | null;
  setTotpSecret: (secret: string | null) => void;
  pendingCode: () => SentCode | null;
  setPendingCode: (code: SentCode | null) => void;
  pendingCodeAddress: () => CodeAddress | null;
  setPendingCodeAddress: (address: CodeAddress | null) => void;
  persistHeader: (header: VaultHeader) => Promise<void>;
  registerSelfAuthenticator: (gate: TotpGateRecord) => Promise<void>;
  header: () => VaultHeader | null;
  trashItem: (id: string) => Promise<void>;
  cancelCodeEnrollment: () => void;
}>;
function totpEnrollment(host: SecondStepHost) {
  const api = {
    /** Offer the authenticator URI; publish its gate only after a matching code. */
    async beginTotpEnrollment(): Promise<string> {
      const { header } = host.requireUnlocked();
      const started = startTotpEnrollment(
        host.ephemeral(),
        primaryUnlockCount(header),
      );
      host.setTotpSecret(started.secret);
      return started.uri;
    },

    /** Prove TOTP, publish the gate, and register the self-authenticator (ADR 0113). */
    async confirmTotpEnrollment(code: string): Promise<void> {
      const { vaultKey, header } = host.requireUnlocked();
      try {
        const gate = await proveTotpEnrollment({
          ephemeral: host.ephemeral(),
          primaryCount: primaryUnlockCount(header),
          secret: host.totpSecret(),
          code,
          vaultKey,
        });
        await host.persistHeader({
          ...header,
          unlocks: { ...header.unlocks, totp: gate },
        });
        await host.registerSelfAuthenticator(gate);
      } catch (error) {
        if (error instanceof UnguardedTotpEnrollment) {
          host.setTotpSecret(null);
        }
        throw error;
      }
      host.setTotpSecret(null);
    },

    /** Abandon an enrollment that never saw a matching code. */
    cancelTotpEnrollment(): void {
      host.setTotpSecret(null);
    },
  };
  return api;
}
function codeEnrollment(host: SecondStepHost) {
  const api = {
    /** Enroll email/text code; nothing is written until a code matches. */
    async beginCodeEnrollment(
      channel: CodeChannel,
      to: string,
    ): Promise<SentCode> {
      const { header } = host.requireUnlocked();
      if (host.ephemeral() || primaryUnlockCount(header) === 0) {
        throw new Error(
          "Seal this vault with a passkey, PIN or password before adding a code by email or text — a code can only guard a key.",
        );
      }
      const sent = await sendCode(channel, to.trim());
      host.setPendingCode(sent);
      host.setPendingCodeAddress({ channel, to: to.trim() });
      return sent;
    },

    /** Prove the first code arrived, then seal the address and turn it on. */
    async confirmCodeEnrollment(code: string): Promise<void> {
      const { vaultKey, header } = host.requireUnlocked();
      const sent = host.pendingCode();
      const address = host.pendingCodeAddress();
      if (!sent || !address) {
        throw new Error("Send a code first.");
      }
      if (host.ephemeral() || primaryUnlockCount(header) === 0) {
        host.cancelCodeEnrollment();
        throw new Error(
          "Seal this vault with a passkey, PIN or password before adding a code by email or text — a code can only guard a key.",
        );
      }
      await verifyCode(sent.challengeId, code);
      const toWrap = await sealText(vaultKey, address.to);
      const unlocks: VaultUnlocks = {
        ...header.unlocks,
        [address.channel]: { toWrap, since: new Date().toISOString() },
      };
      await host.persistHeader({ ...header, unlocks });
      host.setPendingCode(null);
      host.setPendingCodeAddress(null);
    },

    /** Abandon a code enrollment whose first code never matched. */
    cancelCodeEnrollment(): void {
      host.setPendingCode(null);
      host.setPendingCodeAddress(null);
    },
  };
  return api;
}
function recovery(host: SecondStepHost) {
  const api = {
    /** The masked address a code channel sends to; needs the vault open. */
    async describeCodeChannel(channel: CodeChannel): Promise<string | null> {
      const { vaultKey, header } = host.requireUnlocked();
      const record = header.unlocks?.[channel];
      if (!record) return null;
      return maskCodeAddress(channel, await openText(vaultKey, record.toWrap));
    },

    /** Replace the recovery-code set, sealed for Settings to show while unlocked. */
    async generateRecoveryCodes(): Promise<string[]> {
      const { vaultKey, header } = host.requireUnlocked();
      if (!hasSecondStep(header)) {
        throw new Error(
          "Recovery codes stand in for a second step. Add an authenticator, email or text code first.",
        );
      }
      const { codes, record } = await mintRecoveryCodes(vaultKey);
      await host.persistHeader({
        ...header,
        unlocks: { ...header.unlocks, recovery: record },
      });
      return codes;
    },

    /** The recovery codes and which are spent, or null when none were made. */
    async recoveryCodes() {
      const { vaultKey, header } = host.requireUnlocked();
      const record = header.unlocks?.recovery;
      return record ? readRecoveryCodes(vaultKey, record) : null;
    },
  };
  return api;
}
function removal(host: SecondStepHost) {
  /** Drop one second step; the last one takes the recovery codes with it. */
  async function removeSecondStep(step: "totp" | CodeChannel): Promise<void> {
    host.requireUnlocked();
    const header = host.header();
    if (!header?.unlocks?.[step]) return;
    // The authenticator's registration goes with its gate.
    if (step === "totp") {
      const selfId = header.unlocks.totp?.selfItemId;
      if (selfId) await host.trashItem(selfId);
    }
    await host.persistHeader(headerWithoutSecondStep(header, step));
  }
  const api = {
    async removeTotp(): Promise<void> {
      await removeSecondStep("totp");
    },

    async removeCode(channel: CodeChannel): Promise<void> {
      await removeSecondStep(channel);
    },
  };
  return api;
}
export function createStoreSecondStepApi(host: SecondStepHost) {
  return {
    ...totpEnrollment(host),
    ...codeEnrollment(host),
    ...recovery(host),
    ...removal(host),
  };
}
