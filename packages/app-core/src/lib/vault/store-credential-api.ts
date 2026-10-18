/** Current credential mutations retain CRED through the actual private Store publication. */
import {
  type VaultHeader,
  createVault,
  mintVaultKey,
} from "@opensesame/vault-core";
import { withCurrentCredentialRetiredGuard } from "./current-credential-retired-guard.js";
import { headerWithNewPassword, headerWithPassword } from "./master-wrap.js";
import { assertNewVaultScopeEmpty } from "./new-vault-scope-guard.js";
import { wrapVaultKeyWithPin } from "./unlock-methods.js";
import { assertNewPassword, assertNewPin } from "./unlock-secret-guard.js";
type CredentialHost = Readonly<{
  context: () => () => void;
  header: () => VaultHeader | null;
  raw: () => Uint8Array;
  unlockedHeader: () => VaultHeader;
  allowMutation: () => void;
  allowCreation: () => void;
  tomb: () => string;
  publishHeader: (header: VaultHeader, check: () => void) => Promise<void>;
  publishNew: (
    header: VaultHeader,
    key: CryptoKey,
    raw: Uint8Array,
    check: () => void,
  ) => Promise<void>;
}>;
async function createPinMaterial(pin: string) {
  await assertNewPin(pin);
  const material = await mintVaultKey();
  try {
    const record = await wrapVaultKeyWithPin(material.rawVaultKey, pin);
    const header: VaultHeader = {
      v: 1,
      createdAt: new Date().toISOString(),
      unlocks: { pin: record },
    };
    return { ...material, header };
  } catch (error) {
    material.rawVaultKey.fill(0);
    throw error;
  }
}
function creation(host: CredentialHost) {
  const create = async (
    candidate: string,
    material: () => ReturnType<typeof createVault>,
  ) => {
    host.allowCreation();
    await withCurrentCredentialRetiredGuard(
      candidate,
      host.context(),
      async (check) => {
        await assertNewVaultScopeEmpty(host.tomb(), check);
        const next = await material();
        try {
          check();
          await host.publishNew(
            next.header,
            next.vaultKey,
            next.rawVaultKey,
            check,
          );
        } catch (error) {
          next.rawVaultKey.fill(0);
          throw error;
        }
      },
    );
  };
  return {
    create: (password: string, hint?: string) =>
      create(password, async () => {
        await assertNewPassword(password);
        return createVault(password, hint);
      }),
    createWithPin: (pin: string) => create(pin, () => createPinMaterial(pin)),
  };
}
export function createStoreCredentialApi(host: CredentialHost) {
  return {
    ...creation(host),
    async enrollPassword(password: string) {
      const header = host.unlockedHeader();
      const raw = host.raw();
      await withCurrentCredentialRetiredGuard(
        password,
        host.context(),
        async (check) => {
          const next = await headerWithPassword(header, raw, password);
          check();
          await host.publishHeader(next, check);
        },
      );
    },
    async enrollPin(pin: string) {
      const header = host.unlockedHeader();
      await withCurrentCredentialRetiredGuard(
        pin,
        host.context(),
        async (check) => {
          await assertNewPin(pin);
          const record = await wrapVaultKeyWithPin(host.raw(), pin);
          check();
          await host.publishHeader(
            { ...header, unlocks: { ...header.unlocks, pin: record } },
            check,
          );
        },
      );
    },
    async changeMasterPassword(current: string, next: string, hint?: string) {
      host.allowMutation();
      if (!host.header()) throw new Error("There is no vault to re-key.");
      const header = host.unlockedHeader();
      await withCurrentCredentialRetiredGuard(
        next,
        host.context(),
        async (check) => {
          const changed = await headerWithNewPassword(
            header,
            current,
            next,
            hint,
          );
          check();
          await host.publishHeader(changed, check);
        },
      );
    },
  };
}
