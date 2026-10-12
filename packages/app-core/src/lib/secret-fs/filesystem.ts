/**
 * The secret file store on a real directory (ADR 0182), written once over
 * Effect's `FileSystem` service: Node provides the service in `src/node`, and
 * a test provides a fake one to make a disk fail on purpose.
 *
 * Every secret is a file you can `ls`, `git diff`, `chmod`, hand to someone or
 * mount read-only into one container, because that is what makes secrets
 * simple to isolate and share. The store's part in that is to never make a
 * file worse than it found it: a write is staged beside its target, flushed
 * and renamed over it, so a reader — or a power cut — sees the old file or the
 * new one; files are owner-only; and nothing a path says can reach outside the
 * root, symlinks included (`filesystem-guard.ts`).
 */
import { Effect, FileSystem, Semaphore } from "effect";
import { SecretFsConflict } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import { STAGING_SUFFIX, checkPath, revisionOf } from "./files.js";
import type { Revision, SecretFiles } from "./files.js";
import {
  DIRECTORY_MODE,
  FILE_MODE,
  basename,
  confine,
  dirname,
  platform,
  portable,
  withLock,
} from "./filesystem-guard.js";

type Directory = Readonly<{
  fs: FileSystem.FileSystem;
  root: string;
  absolute: (path: string) => string;
}>;

/** Read a file, once its real location is known to be inside the root. */
const readNow = (dir: Directory, path: string) =>
  Effect.gen(function* () {
    const target = dir.absolute(path);
    yield* confine(dir.fs, dir.root, path, target);
    const bytes = yield* platform(path, dir.fs.readFile(target));
    return { bytes, revision: revisionOf(bytes) };
  });

/** Write `bytes` beside `path` and rename them over it, or leave `path` as it was. */
const stageAndRename = (dir: Directory, path: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const { fs } = dir;
    const target = dir.absolute(path);
    const directory = dirname(target);
    yield* confine(fs, dir.root, path, target);
    yield* platform(
      path,
      fs.makeDirectory(directory, { recursive: true, mode: DIRECTORY_MODE }),
    );
    const staged = `${directory}/.${basename(target)}.${crypto.randomUUID()}${STAGING_SUFFIX}`;
    const stage = Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(staged, { flag: "wx", mode: FILE_MODE });
        yield* file.writeAll(bytes);
        yield* file.sync;
      }),
    ).pipe(Effect.andThen(fs.rename(staged, target)));
    yield* platform(path, stage).pipe(
      Effect.tapError(() =>
        fs.remove(staged, { force: true }).pipe(Effect.ignore),
      ),
    );
  });

/** The revision a file is at, or `null` when there is no file. */
const standing = (dir: Directory, path: string) =>
  readNow(dir, path).pipe(
    Effect.map((file) => file.revision),
    Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null)),
  );

const isFile = (fs: FileSystem.FileSystem, target: string) =>
  fs.stat(target).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catch(() => Effect.succeed(false)),
  );

const holds = <E>(effect: Effect.Effect<void, E>) =>
  effect.pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));

/** Every file under `under`, skipping what another tool dropped and what leads out. */
const listFiles = (dir: Directory, under: string) =>
  Effect.gen(function* () {
    const target = dir.absolute(under);
    const entries = yield* platform(
      under,
      dir.fs.readDirectory(target, { recursive: true }),
    ).pipe(
      Effect.catchTag("SecretFsNotFound", () => Effect.succeed([])),
      // `prefix` may name one file rather than a directory.
      Effect.catchTag("SecretFsUnavailable", (error) =>
        isFile(dir.fs, target).pipe(
          Effect.flatMap((file) =>
            file ? Effect.succeed([""]) : Effect.fail(error),
          ),
        ),
      ),
    );
    const found: string[] = [];
    for (const entry of entries) {
      const path = [under, portable(entry)].filter(Boolean).join("/");
      // A file another tool dropped (`.DS_Store`) is not a secret file.
      if (!(yield* holds(checkPath(path).pipe(Effect.asVoid)))) continue;
      const location = dir.absolute(path);
      if (!(yield* isFile(dir.fs, location))) continue;
      if (yield* holds(confine(dir.fs, dir.root, path, location))) {
        found.push(path);
      }
    }
    return found.sort();
  });

export function makeFileSystemSecretFiles(
  rootPath: string,
): Effect.Effect<SecretFiles, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = portable(rootPath).replace(/\/+$/, "") || "/";
    const dir: Directory = {
      fs,
      root,
      absolute: (path) => (path === "" ? root : `${root}/${path}`),
    };
    // One writer at a time in this process; `withLock` covers the others.
    const writer = Semaphore.makeUnsafe(1);

    const read: SecretFiles["read"] = (path) =>
      checkPath(path).pipe(Effect.flatMap((checked) => readNow(dir, checked)));

    const write: SecretFiles["write"] = (path, bytes, options) =>
      Effect.gen(function* () {
        yield* checkPath(path);
        const replace = Effect.gen(function* () {
          if (options?.ifRevision !== undefined) {
            const actual = yield* standing(dir, path);
            if (actual !== options.ifRevision) {
              return yield* new SecretFsConflict({
                path,
                expected: options.ifRevision,
                actual,
              });
            }
          }
          yield* stageAndRename(dir, path, bytes);
          return revisionOf(bytes);
        });
        const guarded: Effect.Effect<Revision, SecretFsError> =
          options?.ifRevision === undefined
            ? replace
            : withLock(fs, root, path, dir.absolute(path), replace);
        return yield* writer.withPermit(guarded);
      });

    const remove: SecretFiles["remove"] = (path) =>
      Effect.gen(function* () {
        yield* checkPath(path);
        const target = dir.absolute(path);
        yield* confine(fs, root, path, target);
        yield* writer.withPermit(
          platform(path, fs.remove(target, { force: true })),
        );
      });

    const list: SecretFiles["list"] = (prefix) =>
      checkPath(prefix, { allowEmpty: true }).pipe(
        Effect.flatMap((under) => listFiles(dir, under)),
      );

    return { read, write, remove, list };
  });
}
