/**
 * Writing a vault as documents (ADR 0182): decide which secrets' files
 * changed, write those, commit the manifest, then clear what no longer
 * belongs. The format and the order are `secret-docs.ts`'s to state.
 */
import type { VaultBody, VaultItem } from "@opensesame/vault-core";
import { Effect } from "effect";
import { SecretFsConflict } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import type { Revision, SecretFiles } from "./files.js";
import {
  CONCURRENCY,
  LEGACY_BODY_FILE,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  type Projected,
  SECRET_FORMAT,
  type TombProjection,
  chooseFile,
  encode,
  kindOf,
  manifestBinding,
  sealed,
  secretBinding,
} from "./secret-docs.js";

type Changed = Readonly<{
  item: VaultItem;
  entry: Projected;
  expect: Revision | undefined;
}>;

/** Decide every item's file, and which of them differ from what is on disk. */
type Plan = Readonly<{
  next: Map<string, Projected>;
  changed: Changed[];
}>;

function plan(body: VaultBody, prev: TombProjection): Plan {
  const rev = body.rev ?? 0;
  const folders = new Map(
    body.folders.map((folder) => [folder.id, folder.name]),
  );
  const claimed = new Set<string>();
  const reserved = new Set([...prev.items.values()].map((entry) => entry.file));
  const next = new Map<string, Projected>();
  const changed: Changed[] = [];
  for (const item of body.items) {
    const folder = item.folderId ? (folders.get(item.folderId) ?? null) : null;
    const prior = prev.items.get(item.id);
    const file = chooseFile(item, folder, prior, claimed, reserved);
    claimed.add(file);
    const json = JSON.stringify(item);
    if (prior && prior.file === file && prior.json === json) {
      next.set(item.id, prior);
      continue;
    }
    const entry = { file, rev, json };
    next.set(item.id, entry);
    changed.push({
      item,
      entry,
      // The file this document replaces, if it is the one we last wrote.
      expect: prior?.file === file ? prior.revision : undefined,
    });
  }
  return { next, changed };
}

/** Look before writing anything: a writer that lost the race finds out before its documents replace the winner's. */
function assertStanding(
  files: SecretFiles,
  tomb: string,
  prev: TombProjection,
): Effect.Effect<void, SecretFsError> {
  const path = `${tomb}/${MANIFEST_FILE}`;
  return Effect.gen(function* () {
    const standing = yield* files.read(path).pipe(
      Effect.map((file) => file.revision),
      Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null)),
    );
    if (standing !== prev.manifestRevision) {
      return yield* new SecretFsConflict({
        path,
        expected: prev.manifestRevision,
        actual: standing,
      });
    }
  });
}

function writeDocument(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  rev: number,
  { item, entry, expect }: Changed,
): Effect.Effect<Revision, SecretFsError> {
  return Effect.gen(function* () {
    const path = `${tomb}/${entry.file}`;
    const blob = yield* sealed(
      key,
      { v: 1, rev, item },
      secretBinding(tomb, item.id),
      path,
    );
    return yield* files.write(
      path,
      encode({
        format: SECRET_FORMAT,
        version: 1,
        kind: kindOf(item),
        sealed: blob,
      }),
      // Another writer's change to this secret since we read it is theirs to keep.
      expect === undefined ? {} : { ifRevision: expect },
    );
  });
}

/** The manifest, written with the revision it was read at: this is what commits. */
function commitManifest(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  body: VaultBody,
  next: ReadonlyMap<string, Projected>,
  prev: TombProjection,
): Effect.Effect<Revision, SecretFsError> {
  const path = `${tomb}/${MANIFEST_FILE}`;
  return Effect.gen(function* () {
    const { items, ...rest } = body;
    const blob = yield* sealed(
      key,
      {
        ...rest,
        items: items.map((item) => ({
          id: item.id,
          file: next.get(item.id)?.file ?? "",
          rev: next.get(item.id)?.rev ?? body.rev ?? 0,
        })),
      },
      manifestBinding(tomb),
      path,
    );
    return yield* files.write(
      path,
      encode({ format: MANIFEST_FORMAT, version: 1, sealed: blob }),
      { ifRevision: prev.manifestRevision },
    );
  });
}

/** Committed: what is left behind past here is clutter, never loss. */
function removeLeftovers(
  files: SecretFiles,
  tomb: string,
  next: ReadonlyMap<string, Projected>,
  prev: TombProjection,
): Effect.Effect<void> {
  const kept = new Set([...next.values()].map((entry) => entry.file));
  const gone = [...prev.items.values()]
    .map((entry) => entry.file)
    .filter((file) => !kept.has(file));
  if (prev.legacyBody) gone.push(LEGACY_BODY_FILE);
  return Effect.forEach(
    gone,
    (file) => files.remove(`${tomb}/${file}`).pipe(Effect.ignore),
    { concurrency: CONCURRENCY, discard: true },
  );
}

/**
 * Write `body` as documents, changed ones first, then the manifest that
 * commits them, then remove what no longer belongs. A document that did not
 * change is not touched, so an edit to one secret rewrites one file.
 */
export function writeProjection(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  body: VaultBody,
  prev: TombProjection,
): Effect.Effect<TombProjection, SecretFsError> {
  return Effect.gen(function* () {
    yield* assertStanding(files, tomb, prev);
    const { next, changed } = plan(body, prev);
    const written = yield* Effect.forEach(
      changed,
      (one) => writeDocument(files, tomb, key, body.rev ?? 0, one),
      { concurrency: CONCURRENCY },
    );
    changed.forEach(({ item, entry }, at) => {
      next.set(item.id, { ...entry, revision: written[at] });
    });
    const manifestRevision = yield* commitManifest(
      files,
      tomb,
      key,
      body,
      next,
      prev,
    );
    yield* removeLeftovers(files, tomb, next, prev);
    return { manifestRevision, items: next, legacyBody: false };
  });
}
