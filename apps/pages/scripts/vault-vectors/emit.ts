import "./install-test-host.js";
import {
  buildOfflineBackup,
  serializeOfflineBackup,
} from "@opensesame/app-core/lib/vault/offline-backup.js";
import { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  wrapVaultKeyWithPin,
  wrapVaultKeyWithPrf,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
/**
 * Golden vault vectors (ADR 0133 §7, docs/architecture/vault-format-v1.md).
 *
 * Emitted ONCE from the code as it stood before the shared-core relocation and
 * committed. Every later step must decrypt them unchanged — in Pages, in the
 * shared core, through the CLI and in a bare isolate. Do not regenerate to make
 * a test pass: a vector that no longer opens is a format break.
 *
 * Synthetic data only. The personal export runs the real store path
 * (`VaultStore.create` → `addItems` → `exportSealed`); variants the current
 * store can no longer produce (a legacy unbound body) or that need a project
 * tomb use the same crypto functions the store calls.
 */
import { overlapCast } from "@opensesame/os-domain";
import {
  type SealedBlob,
  type VaultBody,
  type VaultHeader,
  createItem,
  createVault,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";

/** NFKC folds the fullwidth P and the ﬁ ligature: "Passphrase fixture vector 2026". */
export const VECTOR_PASSWORD = "Ｐassphrase ﬁxture vector 2026";
export const VECTOR_PIN = "73915286";
const PROJECT_ID = "proj_vectors01";
const EXPORTED_AT = "2026-09-22T00:00:00.000Z";

type Expectation = {
  tomb: string;
  bound: boolean;
  rev: number | null;
  items: { id: string; name: string; kind: string }[];
};

type Vector = { file: string; expect: Expectation };

function expectationFor(
  tomb: string,
  bound: boolean,
  body: VaultBody,
): Expectation {
  return {
    tomb,
    bound,
    rev: body.rev ?? null,
    items: body.items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
    })),
  };
}

function syntheticItems(label: string): VaultBody["items"] {
  const login = createItem("login", `${label} login`);
  login.username = "vector-user";
  login.password = "vector-value-not-a-credential";
  login.uris = [
    { id: "uri-1", uri: "https://vectors.example.test", match: "domain" },
  ];
  const note = createItem("note", `${label} note`);
  return [login, note];
}

async function personalExport(): Promise<{ vector: Vector; text: string }> {
  const store = new VaultStore();
  await store.create(VECTOR_PASSWORD, "vector hint");
  await store.addItems(syntheticItems("Personal"));
  await vfsFlush();
  const text = store.exportSealed();
  const items = store.getSnapshot().items;
  const rev = store.getSnapshot().header?.bodyRev ?? null;
  store.lock();
  return {
    text,
    vector: {
      file: text,
      expect: {
        tomb: "personal",
        bound: true,
        rev,
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
        })),
      },
    },
  };
}

function personalBackup(exportText: string, expect: Expectation): Vector {
  const parsed: { header: VaultHeader; body: SealedBlob } = overlapCast(
    JSON.parse(exportText),
  );
  const envelope = buildOfflineBackup({
    projectId: null,
    header: parsed.header,
    body: parsed.body,
    exportedAt: EXPORTED_AT,
  });
  return { file: serializeOfflineBackup(envelope), expect };
}

/** Project tomb, bound, with PIN and passkey-PRF wraps of the same vault key. */
async function projectBackup(prfOutput: Uint8Array): Promise<Vector> {
  const { header, vaultKey, rawVaultKey } = await createVault(VECTOR_PASSWORD);
  const body: VaultBody = {
    v: 1,
    items: syntheticItems("Project"),
    folders: [],
    rev: 1,
  };
  const pin = await wrapVaultKeyWithPin(rawVaultKey, VECTOR_PIN);
  const passkey = await wrapVaultKeyWithPrf(
    rawVaultKey,
    prfOutput.slice().buffer,
    new Uint8Array(32).fill(7),
    new Uint8Array(16).fill(1).buffer,
    new Uint8Array(16).fill(2).buffer,
  );
  rawVaultKey.fill(0);
  const sealed = await sealJson(
    vaultKey,
    body,
    vaultSealBinding(PROJECT_ID, "body"),
  );
  const envelope = buildOfflineBackup({
    projectId: PROJECT_ID,
    header: { ...header, unlocks: { pin, passkeys: [passkey] }, bodyRev: 1 },
    body: sealed,
    exportedAt: EXPORTED_AT,
  });
  return {
    file: serializeOfflineBackup(envelope),
    expect: expectationFor(PROJECT_ID, true, body),
  };
}

/** A body sealed before path binding existed: no additional data. */
async function legacyUnboundExport(): Promise<Vector> {
  const { header, vaultKey } = await createVault(VECTOR_PASSWORD);
  const body: VaultBody = {
    v: 1,
    items: syntheticItems("Legacy"),
    folders: [],
  };
  const sealed = await sealJson(vaultKey, body);
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
  return { file, expect: expectationFor("personal", false, body) };
}

export async function emitVaultVectors(): Promise<string> {
  const prfOutput = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("opensesame vault-vector prf output"),
    ),
  );
  const personal = await personalExport();
  const fixture = {
    about:
      "Golden vault vectors (ADR 0133 §7). Synthetic data. Never regenerate to make a test pass.",
    password: VECTOR_PASSWORD,
    passwordNfkc: VECTOR_PASSWORD.normalize("NFKC"),
    pin: VECTOR_PIN,
    prfOutputB64: btoa(String.fromCharCode(...prfOutput)),
    vectors: {
      "export-personal": personal.vector,
      "backup-personal": personalBackup(personal.text, personal.vector.expect),
      "backup-project": await projectBackup(prfOutput),
      "export-legacy-unbound": await legacyUnboundExport(),
    },
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}
