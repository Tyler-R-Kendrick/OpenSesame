/**
 * The vault's VFS seams (`vfs-seams.ts`) laid over a secret file store
 * (ADR 0182). Install it and every vault file becomes a real file in whatever
 * the store is — a directory the CLI owns, a privately hosted store a PWA
 * reaches over HTTP, or the emulation in a test — through one code path, so
 * the vault behaves the same on all of them.
 *
 * The VFS reads synchronously and the store answers asynchronously, so the
 * adapter keeps a memory mirror: `hydrate` fills it, every read is answered
 * from it, and every write completes only once the store has the bytes (a
 * failed write leaves the mirror as it was, and the VFS's caller undoes its
 * change). Two kinds of file are not simply mirrored:
 *
 * - the vault **body**, which the VFS thinks of as one sealed blob. It is
 *   taken apart into one document per secret when written (`secret-docs.ts`)
 *   and put back together when the vault opens; the blob exists only in the
 *   mirror. A writer with no key (a flat body from before this layout, a
 *   synced snapshot adopted by a device) is stored as `body.json` and becomes
 *   documents at the next write that has one.
 * - every other file (header, config, index, tomb registry), stored as the
 *   text the VFS gave it at `<tomb>/<path>.json`.
 */
import {
  type SealedBlob,
  type VaultBody,
  VaultCorruptError,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { Cause, Effect, Exit } from "effect";
import type { VfsSeams } from "../vfs-seams.js";
import { BODY_PATH, TOMBS_REGISTRY_KEY } from "../vfs.js";
import {
  SETTINGS_DIR,
  configFileFor,
  decodeConfig,
  encodeConfig,
  isPlainPath,
} from "./config-docs.js";
import { SecretFsRejected } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { SECRETS_DIR } from "./layout.js";
import { readProjection } from "./projection-read.js";
import { writeProjection } from "./projection-write.js";
import {
  EMPTY_PROJECTION,
  LEGACY_BODY_FILE,
  MANIFEST_FILE,
  type TombProjection,
} from "./secret-docs.js";

const TOMBS_FILE = "tombs.json";
const TOMB_KEY = /^tomb\/([^/]+)\/(.+)$/;

type Location =
  | Readonly<{ kind: "file"; file: string; path: string }>
  | Readonly<{ kind: "body"; tomb: string }>;

/** The file a VFS key is stored in, or why it cannot be. */
function locate(key: string): Location {
  if (key === TOMBS_REGISTRY_KEY) {
    return { kind: "file", file: TOMBS_FILE, path: TOMBS_REGISTRY_KEY };
  }
  const match = TOMB_KEY.exec(key);
  const [, tomb, path] = match ?? [];
  if (!tomb || !path) throw rejected(key, "is not a vault file");
  if (path === BODY_PATH) return { kind: "body", tomb };
  // These names belong to the layout; a vault file may not stand on them.
  if (
    path === "vault" ||
    path === "secrets" ||
    path.startsWith(`${SECRETS_DIR}/`) ||
    path.startsWith(`${SETTINGS_DIR}/`)
  ) {
    throw rejected(key, "is a name the secret layout keeps for itself");
  }
  // Header and markers are read before the vault opens: plain text, plain name.
  const file = isPlainPath(path) ? `${path}.json` : configFileFor(path);
  return { kind: "file", file: `${tomb}/${file}`, path };
}

function locatable(key: string): Location | null {
  try {
    return locate(key);
  } catch {
    return null;
  }
}

const rejected = (path: string, reason: string) =>
  new SecretFsRejected({ path, kind: "invalid-path", reason });

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Run a store effect and throw what failed, as the error it is. */
async function settle<A>(effect: Effect.Effect<A, SecretFsError>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === "Some") {
    const error = failure.value;
    throw error._tag === "SecretFsRejected" && error.kind === "corrupt"
      ? new VaultCorruptError(error.message)
      : error;
  }
  throw Cause.squash(exit.cause);
}

export type FileBackedVfs = Readonly<{
  /** Load every non-secret file into the mirror. Call once, before the VFS is used. */
  hydrate: () => Promise<void>;
  seams: Required<
    Pick<VfsSeams, "readRaw" | "writeRaw" | "deleteRaw" | "openBody">
  >;
}>;

/** What one adapter holds: the store, a mirror of its raw files, and what it knows of each vault's documents. */
type Held = Readonly<{
  files: SecretFiles;
  mirror: Map<string, string>;
  projections: Map<string, TombProjection>;
}>;

const bodyKey = (tomb: string) => `tomb/${tomb}/${BODY_PATH}`;
const bodyBinding = (tomb: string) => vaultSealBinding(tomb, BODY_PATH);

const openBodyBlob = (
  tomb: string,
  vaultKey: CryptoKey,
  blob: SealedBlob,
): Promise<VaultBody> => openJson<VaultBody>(vaultKey, blob, bodyBinding(tomb));

const PROBE_BINDING = "secret-fs/key-probe";

/** A sealed note that only this key opens, to tell later whether a key is the same one. */
const probeFor = (vaultKey: CryptoKey): Promise<SealedBlob> =>
  sealJson(vaultKey, { probe: 1 }, PROBE_BINDING);

/** Whether the documents recorded in `held` were sealed under `vaultKey`. */
async function sealedUnder(
  held: TombProjection,
  vaultKey: CryptoKey,
): Promise<boolean> {
  if (held.sealedProbe === undefined) return false;
  try {
    await openJson(vaultKey, held.sealedProbe, PROBE_BINDING);
    return true;
  } catch {
    return false;
  }
}

/** The VFS key a stored file answers to by its name alone, or `null` for one that is not a vault file. */
function keyOfFile(
  path: string,
): { key: string; flatBody: string | null } | null {
  if (path === TOMBS_FILE) return { key: TOMBS_REGISTRY_KEY, flatBody: null };
  const [head, ...rest] = path.split("/");
  const rel = rest.join("/");
  if (!head) return null;
  if (rel === LEGACY_BODY_FILE) return { key: bodyKey(head), flatBody: head };
  if (
    rel.endsWith(".json") &&
    rel !== MANIFEST_FILE &&
    !rel.startsWith(`${SECRETS_DIR}/`)
  ) {
    return {
      key: `tomb/${head}/${rel.slice(0, -".json".length)}`,
      flatBody: null,
    };
  }
  return null;
}

async function hydrateAll({ files, mirror, projections }: Held): Promise<void> {
  for (const path of await settle(files.list(""))) {
    const found = keyOfFile(path);
    if (found === null) continue;
    const bytes = (await settle(files.read(path))).bytes;
    if (found.flatBody !== null) {
      projections.set(found.flatBody, {
        ...EMPTY_PROJECTION,
        legacyBody: true,
      });
    }
    // A config document names its own VFS path; any other file is the text it is.
    const config = decodeConfig(bytes);
    if (config !== null) {
      const tomb = path.split("/")[0];
      mirror.set(`tomb/${tomb}/${config.path}`, config.value);
    } else if (
      !path.split("/").slice(1).join("/").startsWith(`${SETTINGS_DIR}/`)
    ) {
      mirror.set(found.key, decode(bytes));
    }
  }
}

/** A body written with the vault key becomes documents; the blob stays in the mirror only. */
async function writeKeyedBody(
  held: Held,
  tomb: string,
  value: string,
  vaultKey: CryptoKey,
): Promise<void> {
  const { files, mirror, projections } = held;
  const prev = projections.get(tomb) ?? EMPTY_PROJECTION;
  const body = await openBodyBlob(tomb, vaultKey, JSON.parse(value));
  // Documents sealed under another key (a rotation) are all written again.
  const base = (await sealedUnder(prev, vaultKey))
    ? prev
    : { ...prev, items: new Map() };
  try {
    const next = await settle(
      writeProjection(files, tomb, vaultKey, body, base),
    );
    projections.set(tomb, { ...next, sealedProbe: await probeFor(vaultKey) });
  } catch (error) {
    // Some documents may have landed though the manifest did not. Forget what
    // was written, so the next save writes every document again and settles it.
    projections.set(tomb, { ...base, items: new Map() });
    throw error;
  }
  mirror.set(bodyKey(tomb), value);
}

async function writeBody(
  held: Held,
  tomb: string,
  value: string,
  vaultKey: CryptoKey | undefined,
): Promise<void> {
  if (vaultKey !== undefined)
    return writeKeyedBody(held, tomb, value, vaultKey);
  // No key to take the body apart with: keep it flat, to be made documents by
  // the next write that has one.
  const { files, mirror, projections } = held;
  await settle(files.write(`${tomb}/${LEGACY_BODY_FILE}`, encode(value)));
  const prev = projections.get(tomb) ?? EMPTY_PROJECTION;
  projections.set(tomb, { ...prev, legacyBody: true });
  mirror.set(bodyKey(tomb), value);
}

/** Destroying a vault removes every secret's file, not only the ones this process knows of. */
async function deleteBody({ files, mirror, projections }: Held, tomb: string) {
  const leftovers = await settle(files.list(`${tomb}/${SECRETS_DIR}`));
  for (const path of [
    ...leftovers,
    `${tomb}/${MANIFEST_FILE}`,
    `${tomb}/${LEGACY_BODY_FILE}`,
  ]) {
    await settle(files.remove(path));
  }
  projections.delete(tomb);
  mirror.delete(bodyKey(tomb));
}

/** Put a vault's body together from its documents and hold it as the blob the VFS reads. */
async function assembleBody(
  { files, mirror, projections }: Held,
  tomb: string,
  vaultKey: CryptoKey,
): Promise<void> {
  const found = await settle(readProjection(files, tomb, vaultKey));
  if (found === null) return;
  const flat = mirror.get(bodyKey(tomb));
  if (flat !== undefined) {
    // A flat body is also on disk (a write with no key, never retired):
    // whichever is further on is the vault.
    const flatBody = await openBodyBlob(tomb, vaultKey, JSON.parse(flat));
    if ((flatBody.rev ?? 0) > (found.body.rev ?? 0)) {
      projections.set(tomb, {
        ...found.state,
        legacyBody: true,
        sealedProbe: await probeFor(vaultKey),
      });
      return;
    }
  }
  const blob = await sealJson(vaultKey, found.body, bodyBinding(tomb));
  mirror.set(bodyKey(tomb), JSON.stringify(blob));
  projections.set(tomb, {
    ...found.state,
    sealedProbe: await probeFor(vaultKey),
  });
}

export function createFileBackedVfs(
  files: SecretFiles,
  fallback: Pick<VfsSeams, "readRaw" | "deleteRaw"> = {
    readRaw: () => null,
    deleteRaw: () => Promise.resolve(),
  },
): FileBackedVfs {
  const held: Held = { files, mirror: new Map(), projections: new Map() };
  // The seams may be called from anywhere, so the adapter orders its own writes.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    hydrate: () => serial(() => hydrateAll(held)),
    seams: {
      readRaw: (key) => held.mirror.get(key) ?? fallback.readRaw(key),
      writeRaw: (key, value, vaultKey) =>
        serial(async () => {
          const where = locate(key);
          if (where.kind === "body") {
            return writeBody(held, where.tomb, value, vaultKey);
          }
          // A sealed value is a declarative document; header and markers are text.
          const doc = encodeConfig(where.path, value);
          await settle(files.write(where.file, doc ?? encode(value)));
          held.mirror.set(key, value);
        }),
      deleteRaw: (key) =>
        serial(async () => {
          // A key that could never have been stored here has nothing to delete.
          const where = locatable(key);
          if (where?.kind === "body") await deleteBody(held, where.tomb);
          if (where?.kind === "file") {
            await settle(files.remove(where.file));
            held.mirror.delete(key);
          }
          await fallback.deleteRaw(key);
        }),
      openBody: (tomb, vaultKey) =>
        serial(() => assembleBody(held, tomb, vaultKey)),
    },
  };
}
