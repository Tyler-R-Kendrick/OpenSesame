/**
 * Reading a vault back from its documents (ADR 0182): the manifest first, then
 * every secret it lists, each held to what the manifest says of it. The rules
 * a read enforces are `secret-docs.ts`'s to state.
 */
import type { VaultBody } from "@opensesame/vault-core";
import { Effect } from "effect";
import type { SecretFsError } from "./errors.js";
import { checkPath } from "./files.js";
import type { SecretFiles } from "./files.js";
import { SECRETS_DIR } from "./layout.js";
import {
  CONCURRENCY,
  LEGACY_BODY_FILE,
  type Listing,
  MANIFEST_FILE,
  type ManifestPayload,
  type Projected,
  type SecretPayload,
  type TombProjection,
  corrupt,
  decodeManifestDoc,
  decodeSecretDoc,
  manifestBinding,
  opened,
  secretBinding,
} from "./secret-docs.js";

export type ReadProjection = Readonly<{
  body: VaultBody;
  state: TombProjection;
}>;
type Listed = Readonly<{ item: SecretPayload["item"]; entry: Projected }>;

/** One listed secret, opened and held to what the manifest says of it. */
function readListed(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  manifestRev: number,
  { id, file, rev }: Listing,
): Effect.Effect<Listed, SecretFsError> {
  return Effect.gen(function* () {
    const path = `${tomb}/${file}`;
    if (!file.startsWith(`${SECRETS_DIR}/`)) {
      return yield* corrupt(path, "is listed outside the secrets directory");
    }
    yield* checkPath(file);
    const stored = yield* files
      .read(path)
      .pipe(
        Effect.catchTag("SecretFsNotFound", () =>
          Effect.fail(corrupt(path, "is listed in the manifest but missing")),
        ),
      );
    const envelope = yield* decodeSecretDoc(stored.bytes, path);
    const payload = yield* opened<SecretPayload>(
      key,
      envelope.sealed,
      secretBinding(tomb, id),
      path,
    );
    // Older than the manifest says is a restored copy; newer by more than the
    // one write that may have died before its manifest is not ours.
    if (
      payload.item.id !== id ||
      payload.rev < rev ||
      payload.rev > manifestRev + 1
    ) {
      return yield* corrupt(path, "is not the revision the manifest lists");
    }
    return {
      item: payload.item,
      entry: { file, rev, json: JSON.stringify(payload.item) },
    };
  });
}

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
    const found = yield* Effect.forEach(
      manifest.items,
      (listing) => readListed(files, tomb, key, manifest.rev ?? 0, listing),
      { concurrency: CONCURRENCY },
    );
    const { items: _listing, ...rest } = manifest;
    const legacy = yield* files
      .read(`${tomb}/${LEGACY_BODY_FILE}`)
      .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
    return {
      body: { ...rest, v: 1, items: found.map((entry) => entry.item) },
      state: {
        manifestRevision: manifestFile.revision,
        items: new Map(found.map(({ item, entry }) => [item.id, entry])),
        legacyBody: legacy,
      },
    };
  });
}
