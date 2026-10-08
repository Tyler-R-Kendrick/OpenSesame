/** Prepare every authenticated seal before atomically publishing a new root's header. */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type SealedBlob,
  type VaultHeader,
  assertSealed,
  importVaultKey,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { assertAuthenticationSession } from "../decoy-session.js";
import { kvRefresh } from "../kv.js";
import { type StoreWriteBarrier, enqueueVfsWrite } from "../vfs-write-queue.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  pinTombAuthority,
  tombFileKey,
  vfsSeams,
} from "../vfs.js";
import { stampedEdit } from "./body-edits.js";
import { noteMasterWrap } from "./master-wrap.js";
import {
  ROTATION_JOURNAL_MAX_BYTES,
  ROTATION_JOURNAL_MAX_FILES,
  ROTATION_JOURNAL_PATH,
  commitRotationJournal,
  hasPendingRotationJournal,
  prepareRotationJournal,
  recoverRotationJournal,
  rollbackPreparedRotation,
} from "./rotation-journal.js";
import { loadVaultBody } from "./store-body.js";
import { readTombHeader } from "./store-header.js";
import { withBodyWriteLock } from "./vault-shared-locks.js";
function blob(raw: string): SealedBlob {
  const parsed: BoundaryValue = JSON.parse(raw);
  if (
    !isJsonObject(parsed) ||
    !isString(parsed.ivB64) ||
    !isString(parsed.ctB64)
  )
    throw new Error("A vault file is not an authenticated seal.");
  const sealed = { ivB64: parsed.ivB64, ctB64: parsed.ctB64 };
  assertSealed(sealed);
  return sealed;
}
async function readIndex(tomb: string, key: CryptoKey, check: () => void) {
  const raw = vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH));
  if (!raw) throw new Error("The vault index is missing.");
  if (raw.length > ROTATION_JOURNAL_MAX_BYTES)
    throw new Error("The vault index exceeds the root-rotation byte limit.");
  const value = await openJson<BoundaryValue>(
    key,
    blob(raw),
    vaultSealBinding(tomb, INDEX_PATH),
  );
  check();
  if (!isJsonObject(value) || !isJsonObject(value.files))
    throw new Error("The vault index is malformed.");
  const files: Record<string, number> = {};
  for (const [path, revision] of Object.entries(value.files)) {
    if (!isNumber(revision)) throw new Error("The vault index is malformed.");
    tombFileKey(tomb, path);
    files[path] = revision;
  }
  return { v: 1, files };
}
function withoutBodyWitness({
  bodyRev: _witness,
  ...authority
}: VaultHeader): string {
  return JSON.stringify(authority);
}
async function prepare(
  tomb: string,
  old: CryptoKey,
  next: CryptoKey,
  header: VaultHeader,
  replacement: VaultHeader,
  check: () => void,
) {
  const previousHeader = vfsSeams.readRaw(tombFileKey(tomb, HEADER_PATH));
  const currentHeader = readTombHeader(tomb);
  if (
    !previousHeader ||
    !currentHeader ||
    withoutBodyWitness(currentHeader) !== withoutBodyWitness(header)
  )
    throw new Error(
      "The vault changed before root rotation. Authenticate again.",
    );
  pinTombAuthority(tomb, old)();
  const index = await readIndex(tomb, old, check);
  const paths = [...new Set([...Object.keys(index.files), BODY_PATH])];
  if (paths.length + 1 > ROTATION_JOURNAL_MAX_FILES)
    throw new Error("The vault exceeds the root-rotation file limit.");
  const originals = new Map<string, string>();
  const previousIndex = vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH));
  if (!previousIndex) throw new Error("The vault index is missing.");
  let bytes = previousHeader.length + JSON.stringify(replacement).length;
  for (const path of paths) {
    check();
    await kvRefresh(tombFileKey(tomb, path), ROTATION_JOURNAL_MAX_BYTES);
    check();
    const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
    if (!raw) throw new Error("An indexed vault file is missing.");
    bytes += new TextEncoder().encode(raw).byteLength;
    if (bytes > ROTATION_JOURNAL_MAX_BYTES)
      throw new Error("The vault exceeds the root-rotation byte limit.");
    originals.set(path, raw);
  }
  const body = await loadVaultBody(tomb, old, currentHeader);
  check();
  stampedEdit((opened) => noteMasterWrap(opened, replacement))(body);
  body.rev = (body.rev ?? 0) + 1;
  const nextHeader = { ...replacement, bodyRev: body.rev };
  const files: Record<string, string> = {};
  for (const [path, raw] of originals) {
    check();
    const value =
      path === BODY_PATH
        ? body
        : await openJson<BoundaryValue>(
            old,
            blob(raw),
            vaultSealBinding(tomb, path),
          );
    check();
    files[path] = JSON.stringify(
      await sealJson(next, value, vaultSealBinding(tomb, path)),
    );
    check();
  }
  index.files[BODY_PATH] = (index.files[BODY_PATH] ?? 0) + 1;
  originals.set(INDEX_PATH, previousIndex);
  files[INDEX_PATH] = JSON.stringify(
    await sealJson(next, index, vaultSealBinding(tomb, INDEX_PATH)),
  );
  check();
  const serialized = prepareRotationJournal({
    tomb,
    token: crypto.randomUUID(),
    previousHeader,
    nextHeader: JSON.stringify(nextHeader),
    files,
  });
  return { serialized, body, header: nextHeader, originals };
}
export function rotateRootDataset(
  chain: StoreWriteBarrier,
  tomb: string,
  old: CryptoKey | null,
  header: VaultHeader | null,
  raw: Uint8Array,
  replacement: VaultHeader,
  check: () => void,
) {
  return chain.then(() =>
    withBodyWriteLock(tomb, () =>
      enqueueVfsWrite(
        tomb,
        async () => {
          try {
            check();
            await kvRefresh(
              tombFileKey(tomb, ROTATION_JOURNAL_PATH),
              ROTATION_JOURNAL_MAX_BYTES,
            );
            check();
            if (hasPendingRotationJournal(tomb))
              throw new Error(
                "A vault rotation is already pending. Lock and authenticate again.",
              );
            if (!old || !header)
              throw new Error("Unlock the vault before root rotation.");
            const key = await importVaultKey(raw);
            check();
            const prepared = await prepare(
              tomb,
              old,
              key,
              header,
              replacement,
              check,
            );
            try {
              await commitRotationJournal(tomb, prepared.serialized, check);
            } catch (error) {
              await rollbackPreparedRotation(
                tomb,
                prepared.serialized,
                prepared.originals,
                check,
              ).catch(() => undefined);
              throw error;
            }
            check();
            return { key, body: prepared.body, header: prepared.header };
          } catch (error) {
            raw.fill(0);
            throw error;
          }
        },
        true,
      ),
    ),
  );
}
/** Ciphertext-only roll-forward runs before selecting any credential verifier. */
export async function recoverPreparedRoot(
  tomb: string,
  fallback: VaultHeader | null,
  check: () => void,
): Promise<VaultHeader | null> {
  const realm = assertAuthenticationSession();
  const current = () => {
    assertAuthenticationSession(realm);
    check();
  };
  await kvRefresh(
    tombFileKey(tomb, ROTATION_JOURNAL_PATH),
    ROTATION_JOURNAL_MAX_BYTES,
  );
  current();
  if (!hasPendingRotationJournal(tomb)) return fallback;
  return withBodyWriteLock(tomb, () =>
    enqueueVfsWrite(
      tomb,
      async () => {
        current();
        const recovered = await recoverRotationJournal(tomb, current);
        current();
        return recovered ? readTombHeader(tomb) : fallback;
      },
      true,
    ),
  );
}
