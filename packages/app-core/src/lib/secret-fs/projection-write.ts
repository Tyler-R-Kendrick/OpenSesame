/**
 * Writing a vault as documents (ADR 0182): decide which secrets' files
 * changed, write those, commit the manifest, then clear what no longer
 * belongs. The format and the order are `secret-docs.ts`'s to state.
 */
import type { Folder, VaultBody, VaultItem } from "@opensesame/vault-core";
import { Effect } from "effect";
import { SecretFsConflict } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import type { Revision, SecretFiles } from "./files.js";
import type { SecretFileName } from "./layout.js";
import {
  CONCURRENCY,
  FOLDER_FORMAT,
  LEGACY_BODY_FILE,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  type Projected,
  SECRET_FORMAT,
  type TombProjection,
  chooseFile,
  encode,
  folderBinding,
  kindOf,
  manifestBinding,
  sealed,
  secretBinding,
} from "./secret-docs.js";

/** What becomes a document: a folder (its directory's marker) or a secret. */
type Subject =
  | Readonly<{
      kind: "folder";
      id: string;
      label: SecretFileName;
      folder: Folder;
    }>
  | Readonly<{
      kind: "item";
      id: string;
      label: SecretFileName;
      item: VaultItem;
    }>;

type Changed = Readonly<{
  subject: Subject;
  entry: Projected;
  expect: Revision | undefined;
}>;

/** Folders first, so a secret never takes the name a folder's marker needs. */
function subjects(body: VaultBody): Subject[] {
  const names = new Map(body.folders.map((folder) => [folder.id, folder.name]));
  return [
    ...body.folders.map(
      (folder): Subject => ({
        kind: "folder",
        id: folder.id,
        folder,
        label: {
          folder: folder.name,
          name: "folder",
          kind: "dir",
          id: folder.id,
        },
      }),
    ),
    ...body.items.map(
      (item): Subject => ({
        kind: "item",
        id: item.id,
        item,
        label: {
          folder: item.folderId ? (names.get(item.folderId) ?? null) : null,
          name: item.name,
          kind: kindOf(item),
          id: item.id,
        },
      }),
    ),
  ];
}

type Plan = Readonly<{
  next: Map<string, Projected>;
  changed: Changed[];
}>;

/** Decide every document's file, and which of them differ from what is on disk. */
function plan(body: VaultBody, prev: TombProjection): Plan {
  const rev = body.rev ?? 0;
  const claimed = new Set<string>();
  const reserved = new Set([...prev.items.values()].map((entry) => entry.file));
  const next = new Map<string, Projected>();
  const changed: Changed[] = [];
  for (const subject of subjects(body)) {
    const prior = prev.items.get(subject.id);
    const file = chooseFile(subject.label, prior, claimed, reserved);
    claimed.add(file);
    const json = JSON.stringify(
      subject.kind === "item" ? subject.item : subject.folder,
    );
    if (prior && prior.file === file && prior.json === json) {
      next.set(subject.id, prior);
      continue;
    }
    const entry = { file, rev, json };
    next.set(subject.id, entry);
    changed.push({
      subject,
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
  { subject, entry, expect }: Changed,
): Effect.Effect<Revision, SecretFsError> {
  return Effect.gen(function* () {
    const path = `${tomb}/${entry.file}`;
    const doc =
      subject.kind === "item"
        ? encode({
            format: SECRET_FORMAT,
            version: 1,
            kind: kindOf(subject.item),
            sealed: yield* sealed(
              key,
              { v: 1, rev, item: subject.item },
              secretBinding(tomb, subject.id),
              path,
            ),
          })
        : encode({
            format: FOLDER_FORMAT,
            version: 1,
            sealed: yield* sealed(
              key,
              { v: 1, rev, folder: subject.folder },
              folderBinding(tomb, subject.id),
              path,
            ),
          });
    return yield* files.write(
      path,
      doc,
      // Another writer's change to this document since we read it is theirs to keep.
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
    const { items, folders, ...rest } = body;
    const listing = (id: string) => ({
      id,
      file: next.get(id)?.file ?? "",
      rev: next.get(id)?.rev ?? body.rev ?? 0,
    });
    const blob = yield* sealed(
      key,
      {
        ...rest,
        items: items.map((item) => listing(item.id)),
        folders: folders.map((folder) => listing(folder.id)),
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
    changed.forEach(({ subject, entry }, at) => {
      next.set(subject.id, { ...entry, revision: written[at] });
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
