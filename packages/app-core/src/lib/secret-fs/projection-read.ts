/**
 * Reading a vault back from its documents (ADR 0182): the manifest first, then
 * every secret it lists, each held to what the manifest says of it. The rules
 * a read enforces are `secret-docs.ts`'s to state.
 */
import type { Folder, VaultBody, VaultItem } from "@opensesame/vault-core";
import { Effect } from "effect";
import type { SecretFsError } from "./errors.js";
import { checkPath } from "./files.js";
import type { SecretFiles } from "./files.js";
import { SECRETS_DIR } from "./layout.js";
import {
  CONCURRENCY,
  type FolderPayload,
  LEGACY_BODY_FILE,
  type Listing,
  MANIFEST_FILE,
  type ManifestPayload,
  type Projected,
  type SecretPayload,
  type TombProjection,
  corrupt,
  decodeFolderDoc,
  decodeManifestDoc,
  decodeSecretDoc,
  folderBinding,
  manifestBinding,
  opened,
  secretBinding,
} from "./secret-docs.js";

export type ReadProjection = Readonly<{
  body: VaultBody;
  state: TombProjection;
}>;
type Listed<T> = Readonly<{ value: T; entry: Projected }>;

/** The stored bytes of a listed document, from a path the manifest may name. */
function readStored(files: SecretFiles, tomb: string, file: string) {
  const path = `${tomb}/${file}`;
  return Effect.gen(function* () {
    if (!file.startsWith(`${SECRETS_DIR}/`)) {
      return yield* corrupt(path, "is listed outside the secrets directory");
    }
    yield* checkPath(file);
    return yield* files
      .read(path)
      .pipe(
        Effect.catchTag("SecretFsNotFound", () =>
          Effect.fail(corrupt(path, "is listed in the manifest but missing")),
        ),
      );
  });
}

/**
 * Hold what a document says to what the manifest says of it. Older than listed
 * is a restored copy; newer by more than the one write that may have died
 * before its manifest is not ours.
 */
type Stored = Readonly<{ revision: string }>;
type Held<T> = Readonly<{ rev: number; value: T }>;

function held<T extends { id: string }>(
  tomb: string,
  { id, file, rev }: Listing,
  manifestRev: number,
  stored: Stored,
  document: Held<T>,
): Effect.Effect<Listed<T>, SecretFsError> {
  if (
    document.value.id !== id ||
    document.rev < rev ||
    document.rev > manifestRev + 1
  ) {
    return Effect.fail(
      corrupt(`${tomb}/${file}`, "is not the revision the manifest lists"),
    );
  }
  return Effect.succeed({
    value: document.value,
    entry: {
      file,
      rev,
      json: JSON.stringify(document.value),
      revision: stored.revision,
    },
  });
}

function readItem(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  manifestRev: number,
  listing: Listing,
): Effect.Effect<Listed<VaultItem>, SecretFsError> {
  const path = `${tomb}/${listing.file}`;
  return Effect.gen(function* () {
    const stored = yield* readStored(files, tomb, listing.file);
    const doc = yield* decodeSecretDoc(stored.bytes, path);
    const payload = yield* opened<SecretPayload>(
      key,
      doc.sealed,
      secretBinding(tomb, listing.id),
      path,
    );
    return yield* held(tomb, listing, manifestRev, stored, {
      rev: payload.rev,
      value: payload.item,
    });
  });
}

function readFolder(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  manifestRev: number,
  listing: Listing,
): Effect.Effect<Listed<Folder>, SecretFsError> {
  const path = `${tomb}/${listing.file}`;
  return Effect.gen(function* () {
    const stored = yield* readStored(files, tomb, listing.file);
    const doc = yield* decodeFolderDoc(stored.bytes, path);
    const payload = yield* opened<FolderPayload>(
      key,
      doc.sealed,
      folderBinding(tomb, listing.id),
      path,
    );
    return yield* held(tomb, listing, manifestRev, stored, {
      rev: payload.rev,
      value: payload.folder,
    });
  });
}

const isListing = (entry: Listing | Folder): entry is Listing =>
  "file" in entry;

/** Rebuild the body from its documents, or `null` when the vault has no manifest. */
export function readProjection(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
): Effect.Effect<ReadProjection | null, SecretFsError> {
  return Effect.gen(function* () {
    const manifestPath = `${tomb}/${MANIFEST_FILE}`;
    const manifestFile = yield* files
      .read(manifestPath)
      .pipe(Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null)));
    if (manifestFile === null) return null;
    const doc = yield* decodeManifestDoc(manifestFile.bytes, manifestPath);
    const manifest = yield* opened<ManifestPayload>(
      key,
      doc.sealed,
      manifestBinding(tomb),
      manifestPath,
    );
    const rev = manifest.rev ?? 0;
    const foundItems = yield* Effect.forEach(
      manifest.items,
      (listing) => readItem(files, tomb, key, rev, listing),
      { concurrency: CONCURRENCY },
    );
    // A manifest from before folders were files holds them whole.
    const listedFolders = manifest.folders.filter(isListing);
    const foundFolders = yield* Effect.forEach(
      listedFolders,
      (listing) => readFolder(files, tomb, key, rev, listing),
      { concurrency: CONCURRENCY },
    );
    const wholeFolders = manifest.folders.filter(
      (entry): entry is Folder => !isListing(entry),
    );
    const { items: _items, folders: _folders, ...rest } = manifest;
    const legacy = yield* files
      .read(`${tomb}/${LEGACY_BODY_FILE}`)
      .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
    return {
      body: {
        ...rest,
        v: 1,
        items: foundItems.map((found) => found.value),
        folders: [...foundFolders.map((found) => found.value), ...wholeFolders],
      },
      state: {
        manifestRevision: manifestFile.revision,
        items: new Map(
          [...foundItems, ...foundFolders].map((found) => [
            found.value.id,
            found.entry,
          ]),
        ),
        legacyBody: legacy,
      },
    };
  });
}
