/**
 * The golden vector for credentials that are entries of their own (ADR 0179).
 *
 * One body holds an account with two credentials bound to it, a password kept
 * on its own, and an API key whose account is not in the body. A listing names
 * the account, the password and the API key whose account is missing, and not
 * the two bound ones: they are part of the account's file. Synthetic data only.
 * Added beside the others once (`--add credentials`); never regenerate to make a
 * test pass.
 */
import {
  type AccountItem,
  type VaultBody,
  buildOfflineBackupEnvelope,
  createCredential,
  createItem,
  createVault,
  manualPassword,
  sealJson,
  serializeOfflineBackupEnvelope,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { VECTOR_ACCOUNT_PASSWORD } from "./emit-accounts.js";

const EXPORTED_AT = "2026-10-06T00:00:00.000Z";

type Held = { body: VaultBody["items"]; listed: string[] };

function items(): Held {
  const account: AccountItem = {
    ...createItem("account", "Personal bound account"),
    methods: [],
  };
  account.username = "vector-user";
  const password = createCredential(
    manualPassword(
      `${account.id}:password`,
      "vector-bound-pw-not-a-credential",
      EXPORTED_AT,
    ),
    "Personal bound account · Password",
    account.id,
  );
  const key = createCredential(
    {
      id: `${account.id}:key`,
      type: "api-key",
      key: "vector-bound-key-not-a-credential",
      header: "X-Vector-Key",
    },
    "Personal bound account · API key",
    account.id,
  );
  const own = createCredential(
    manualPassword(
      "vector-own-password",
      "vector-own-pw-not-a-credential",
      EXPORTED_AT,
    ),
    "Personal spare password",
    null,
  );
  const orphan = createCredential(
    {
      id: "vector-orphan-key",
      type: "api-key",
      key: "vector-orphan-key-not-a-credential",
      header: "X-Vector-Orphan",
    },
    "Personal orphaned key",
    "no-such-account",
  );
  return {
    body: [account, password, key, own, orphan],
    listed: [account.id, own.id, orphan.id],
  };
}

export async function emitCredentialVectors() {
  const { header, vaultKey, rawVaultKey } = await createVault(
    VECTOR_ACCOUNT_PASSWORD,
    "vector hint",
  );
  rawVaultKey.fill(0);
  const { body: held, listed } = items();
  const body: VaultBody = { v: 1, items: held, folders: [], rev: 4 };
  const sealed = await sealJson(
    vaultKey,
    body,
    vaultSealBinding("personal", "body"),
  );
  const envelope = buildOfflineBackupEnvelope({
    projectId: null,
    header: { ...header, bodyRev: 4 },
    body: sealed,
    exportedAt: EXPORTED_AT,
  });
  return {
    "backup-personal-credentials": {
      file: serializeOfflineBackupEnvelope(envelope),
      expect: {
        tomb: "personal",
        bound: true,
        rev: 4,
        items: held
          .filter((item) => listed.includes(item.id))
          .map(({ id, name, kind }) => ({ id, name, kind })),
      },
    },
  };
}
