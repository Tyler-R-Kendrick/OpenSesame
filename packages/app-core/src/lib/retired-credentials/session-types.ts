import type { VaultItem } from "@opensesame/vault-core";
/** Host-independent synthetic vault creation. No protected-root operation is granted. */
export type RetiredCredentialSessionStore = Readonly<{
  createGuest: (options?: {
    resume?: boolean;
    decoy?: boolean;
    isolated?: boolean;
  }) => Promise<void>;
  cancelTotpChallenge?: () => void;
  addItems?: (items: VaultItem[]) => Promise<void>;
}>;
