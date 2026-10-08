import type { VaultBody, VaultHeader } from "@opensesame/vault-core";
import { heldTotpCode } from "./self-authenticator.js";
import { hasSecondStep } from "./unlock-methods.js";
type PrimarySession = {
  header: VaultHeader | null;
  assertCurrent(): void;
  refuse(): void;
  park(): void;
  loadBody(): Promise<VaultBody>;
  confirmTotp(code: string): Promise<void>;
  activate(): Promise<void>;
  armChallenge(): void;
};

/** Primary proof remains bound while a self-authenticator or second step runs. */
export async function continuePrimarySession(
  host: PrimarySession,
): Promise<void> {
  host.assertCurrent();
  host.refuse();
  if (!hasSecondStep(host.header)) {
    await host.activate();
    return;
  }
  host.park();
  const gate = host.header?.unlocks?.totp;
  if (gate?.selfItemId) {
    const body = await host.loadBody();
    host.assertCurrent();
    const code = await heldTotpCode(gate, body);
    host.assertCurrent();
    if (code !== null) {
      try {
        await host.confirmTotp(code);
        return;
      } catch {
        host.assertCurrent();
      }
    }
  }
  host.assertCurrent();
  host.armChallenge();
}
