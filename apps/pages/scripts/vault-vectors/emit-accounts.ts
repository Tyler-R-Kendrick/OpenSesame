/**
 * Golden vectors that hold `account` items (ADR 0172 §1, ADR 0133 §7).
 *
 * The first five vectors hold legacy `login` items and stay byte for byte as
 * emitted: a vault Pages has not opened since the account change still reads.
 * These are added beside them, under new keys, once. They use only
 * `@opensesame/vault-core` (the same crypto the store calls), so they depend on
 * no store, no host and no UI.
 *
 * Each personal/project body holds one account per way a login can be kept:
 *
 *   - `Plain account`     a manual password in the clear, and an authenticator
 *   - `Peppered account`  a password sealed under a pepper (`sealed`; the
 *                         pepper is `accountPepper` in the fixture)
 *   - `Derived account`   a sphinx password (`oprfKeyB64`, nothing stored) and
 *                         an authenticator
 *   - `Keyed account`     an api-key, a token and an oauth method
 *
 * Names avoid the words a method stores as a value (`sphinx`, `manual`, ...):
 * a listing must never contain a field value, and the readers' tests check
 * that by looking for every stored string in what they print.
 *
 * Synthetic data only. Never regenerate to make a test pass.
 */
import {
  type AccountItem,
  DEFAULT_RULES,
  type SealedBlob,
  type VaultBody,
  type VaultHeader,
  buildOfflineBackupEnvelope,
  createItem,
  createVault,
  manualPassword,
  mintRootSecret,
  pepperBinding,
  sealJson,
  sealWithPepper,
  serializeOfflineBackupEnvelope,
  vaultSealBinding,
} from "@opensesame/vault-core";

export const VECTOR_ACCOUNT_PASSWORD = "Ｐassphrase ﬁxture vector 2026";
/** The pepper that opens the `Peppered account` password. Not a credential. */
export const VECTOR_PEPPER = "vector pepper not a credential";
const PROJECT_ID = "proj_vectors01";
const EXPORTED_AT = "2026-10-05T00:00:00.000Z";
const SITE = {
  id: "uri-1",
  uri: "https://vectors.example.test",
  match: "domain",
} as const;
/** A valid ristretto255 scalar (little endian, top byte under 0x10). */
const OPRF_KEY_B64 = btoa(
  String.fromCharCode(
    ...Array.from({ length: 32 }, (_, i) => (i < 31 ? i + 1 : 7)),
  ),
);

type Expectation = {
  tomb: string;
  bound: boolean;
  rev: number | null;
  items: { id: string; name: string; kind: string }[];
};
type Vector = { file: string; expect: Expectation };

type PersonalVectors = { export: Vector; backup: Vector };

type SealedPersonal = {
  header: VaultHeader;
  sealed: SealedBlob;
  body: VaultBody;
};

type AccountVectors = {
  vectors: Record<string, Vector>;
  accountPepper: string;
  accountPepperAbout: string;
};

function account(label: string): AccountItem {
  const item = createItem("account", label);
  item.username = "vector-user";
  item.uris = [SITE];
  return item;
}

async function accountItems(label: string): Promise<VaultBody["items"]> {
  const plain = account(`${label} plain account`);
  plain.methods = [
    manualPassword(
      `${plain.id}:password`,
      "vector-plain-not-a-credential",
      EXPORTED_AT,
    ),
    {
      id: `${plain.id}:authenticator`,
      type: "authenticator",
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    },
  ];

  const peppered = account(`${label} peppered account`);
  const pepperedId = `${peppered.id}:password`;
  peppered.methods = [
    {
      id: pepperedId,
      type: "password",
      generator: { id: "manual" },
      pepper: true,
      secret: "",
      sealed: await sealWithPepper(
        "vector-peppered-not-a-credential",
        VECTOR_PEPPER,
        pepperBinding(peppered.id, pepperedId),
      ),
      changedAt: EXPORTED_AT,
    },
  ];

  const sphinx = account(`${label} derived account`);
  sphinx.methods = [
    {
      id: `${sphinx.id}:password`,
      type: "password",
      generator: {
        id: "sphinx",
        rules: { ...DEFAULT_RULES },
        realm: "vectors.example.test",
        counter: 1,
        oprfKeyB64: OPRF_KEY_B64,
      },
      pepper: true,
      secret: "",
      changedAt: EXPORTED_AT,
    },
    {
      id: `${sphinx.id}:authenticator`,
      type: "authenticator",
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    },
  ];

  const keyed = account(`${label} keyed account`);
  keyed.methods = [
    {
      id: `${keyed.id}:api-key`,
      type: "api-key",
      key: "vector-api-key-not-a-credential",
      header: "X-Vector-Key",
    },
    {
      id: `${keyed.id}:token`,
      type: "token",
      token: "vector-token-not-a-credential",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    {
      id: `${keyed.id}:oauth`,
      type: "oauth",
      clientId: "vector-client-id",
      clientSecret: "vector-client-secret-not-a-credential",
      tokenUrl: "https://vectors.example.test/oauth/token",
      scopes: "read write",
      refreshToken: "vector-refresh-not-a-credential",
    },
  ];

  return [plain, peppered, sphinx, keyed, createItem("note", `${label} note`)];
}

function expectationFor(
  tomb: string,
  bound: boolean,
  body: VaultBody,
): Expectation {
  return {
    tomb,
    bound,
    rev: body.rev ?? null,
    items: body.items.map(({ id, name, kind }) => ({ id, name, kind })),
  };
}

async function sealedPersonal(): Promise<SealedPersonal> {
  const { header, vaultKey, rawVaultKey } = await createVault(
    VECTOR_ACCOUNT_PASSWORD,
    "vector hint",
  );
  rawVaultKey.fill(0);
  const body: VaultBody = {
    v: 1,
    items: await accountItems("Personal"),
    folders: [],
    rev: 2,
  };
  const sealed = await sealJson(
    vaultKey,
    body,
    vaultSealBinding("personal", "body"),
  );
  return { header: { ...header, bodyRev: 2 }, sealed, body };
}

/** The personal tomb as an encrypted export, and as an offline backup. */
async function personalVectors(): Promise<PersonalVectors> {
  const { header, sealed, body } = await sealedPersonal();
  const expect = expectationFor("personal", true, body);
  const file = JSON.stringify(
    {
      format: "opensesame-vault-export",
      v: 1,
      exportedAt: EXPORTED_AT,
      tomb: "personal",
      header,
      body: sealed,
    },
    null,
    2,
  );
  const envelope = buildOfflineBackupEnvelope({
    projectId: null,
    header,
    body: sealed,
    exportedAt: EXPORTED_AT,
  });
  return {
    export: { file, expect },
    backup: { file: serializeOfflineBackupEnvelope(envelope), expect },
  };
}

/** A project tomb, bound to its id, holding the same four ways to keep a login. */
async function projectBackup(): Promise<Vector> {
  const { header, vaultKey, rawVaultKey } = await createVault(
    VECTOR_ACCOUNT_PASSWORD,
  );
  rawVaultKey.fill(0);
  const body: VaultBody = {
    v: 1,
    items: await accountItems("Project"),
    folders: [],
    rev: 1,
  };
  const sealed = await sealJson(
    vaultKey,
    body,
    vaultSealBinding(PROJECT_ID, "body"),
  );
  const envelope = buildOfflineBackupEnvelope({
    projectId: PROJECT_ID,
    header: { ...header, bodyRev: 1 },
    body: sealed,
    exportedAt: EXPORTED_AT,
  });
  return {
    file: serializeOfflineBackupEnvelope(envelope),
    expect: expectationFor(PROJECT_ID, true, body),
  };
}

/**
 * The new vectors, keyed by name, and the fixture-level fields they need.
 * Nothing here is added to an existing key.
 */
export async function emitAccountVectors(): Promise<AccountVectors> {
  const personal = await personalVectors();
  return {
    vectors: {
      "export-personal-accounts": personal.export,
      "backup-personal-accounts": personal.backup,
      "backup-project-accounts": await projectBackup(),
    },
    accountPepper: VECTOR_PEPPER,
    accountPepperAbout:
      "The pepper that opens the sealed password of each `peppered account` item in the *-accounts vectors (ADR 0172 section 4). Synthetic; the pepper is never stored in a vault.",
  };
}

/**
 * The derived password (ADR 0173) kept both ways, added once beside the others
 * under its own key: a root and the parameters it is computed from, and the same
 * with *Include pepper* on, which keeps only where the pepper goes (ADR 0174).
 * No password and no pepper is in either. The names avoid `derived`, which is
 * now a value a method stores.
 */
function derivedItems(): VaultBody["items"] {
  const clear = account("Personal computed account");
  clear.methods = [
    {
      id: `${clear.id}:password`,
      type: "password",
      generator: { id: "derived", rules: { ...DEFAULT_RULES }, counter: 2 },
      pepper: false,
      secret: mintRootSecret(),
      changedAt: EXPORTED_AT,
    },
  ];
  const slotted = account("Personal computed slotted account");
  slotted.methods = [
    {
      id: `${slotted.id}:password`,
      type: "password",
      generator: { id: "derived", rules: { ...DEFAULT_RULES }, counter: 0 },
      pepper: true,
      pepperAt: "-4",
      secret: mintRootSecret(),
      changedAt: EXPORTED_AT,
    },
  ];
  return [clear, slotted];
}

/** The derived vector, keyed by name. Nothing here is added to an existing key. */
export async function emitDerivedVectors() {
  const { header, vaultKey, rawVaultKey } = await createVault(
    VECTOR_ACCOUNT_PASSWORD,
    "vector hint",
  );
  rawVaultKey.fill(0);
  const body: VaultBody = {
    v: 1,
    items: derivedItems(),
    folders: [],
    rev: 3,
  };
  const sealed = await sealJson(
    vaultKey,
    body,
    vaultSealBinding("personal", "body"),
  );
  const envelope = buildOfflineBackupEnvelope({
    projectId: null,
    header: { ...header, bodyRev: 3 },
    body: sealed,
    exportedAt: EXPORTED_AT,
  });
  return {
    "backup-personal-derived": {
      file: serializeOfflineBackupEnvelope(envelope),
      expect: expectationFor("personal", true, body),
    },
  };
}
