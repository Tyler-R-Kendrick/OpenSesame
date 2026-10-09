/**
 * What keeps a directory store inside its root and its writers apart
 * (ADR 0182): the failure mapping from the platform, the check that a path's
 * real location is still under the root (a planted symlink cannot lead out of
 * it), and the lock file that stops a second process slipping between a
 * revision check and the swap that follows it.
 */
import { Effect, type FileSystem, Option, Schedule } from "effect";
import type { PlatformError } from "effect/PlatformError";
import {
  SecretFsNotFound,
  SecretFsRejected,
  SecretFsUnavailable,
} from "./errors.js";
import type { SecretFsError } from "./errors.js";

export const FILE_MODE = 0o600;
export const DIRECTORY_MODE = 0o700;
/** A lock older than this was left by a process that died holding it. */
const LOCK_STALE_MS = 15_000;
const LOCK_EVERY = "20 millis";
// Long enough to outlast a stale lock left by a process that died.
const LOCK_TRIES = 800;

export const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"));
export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const portable = (path: string) => path.replaceAll("\\", "/");

/** Name a platform failure the way every other backend names it. */
function classify(path: string, error: PlatformError): SecretFsError {
  const reason = error.reason;
  if (reason._tag === "BadArgument") {
    return new SecretFsRejected({
      path,
      kind: "invalid-path",
      reason: reason.description ?? "bad argument",
    });
  }
  switch (reason._tag) {
    case "NotFound":
      return new SecretFsNotFound({ path });
    case "PermissionDenied":
      return new SecretFsRejected({
        path,
        kind: "permission",
        reason: "the operating system refused access",
      });
    default:
      return new SecretFsUnavailable({
        path,
        reason: `${reason._tag}: ${reason.description ?? reason.method}`,
      });
  }
}

export const platform = <A>(
  path: string,
  effect: Effect.Effect<A, PlatformError>,
): Effect.Effect<A, SecretFsError> =>
  Effect.mapError(effect, (error) => classify(path, error));

/** The real location of `target`, or of its nearest ancestor that exists. */
function resolved(
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<string, PlatformError> {
  return fs.realPath(target).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound" && target.length > 1,
      () =>
        resolved(fs, dirname(target) || "/").pipe(
          Effect.map((real) => `${real}/${basename(target)}`),
        ),
    ),
    Effect.map(portable),
  );
}

/** Refuse a path whose real location is outside the root. */
export function confine(
  fs: FileSystem.FileSystem,
  root: string,
  path: string,
  target: string,
): Effect.Effect<void, SecretFsError> {
  return Effect.gen(function* () {
    const real = yield* platform(path, resolved(fs, target));
    const base = yield* platform(path, resolved(fs, root));
    if (real !== base && !real.startsWith(`${base}/`)) {
      return yield* new SecretFsRejected({
        path,
        kind: "invalid-path",
        reason: "the path resolves outside the store",
      });
    }
  });
}

/** A lock whose holder is long gone is removed, so the next try can take it. */
function breakStale(fs: FileSystem.FileSystem, lock: string) {
  return fs.stat(lock).pipe(
    Effect.flatMap((info) =>
      Option.isSome(info.mtime) &&
      Date.now() - info.mtime.value.getTime() > LOCK_STALE_MS
        ? fs.remove(lock, { force: true })
        : Effect.void,
    ),
    Effect.ignore,
  );
}

/**
 * Hold `.<name>.lock` beside `target` while `work` checks a revision and
 * replaces the file. The caller's in-process mutex covers this process's own
 * writers; this covers every other process.
 */
export function withLock<A>(
  fs: FileSystem.FileSystem,
  root: string,
  path: string,
  target: string,
  work: Effect.Effect<A, SecretFsError>,
): Effect.Effect<A, SecretFsError> {
  const lock = `${dirname(target)}/.${basename(target)}.lock`;
  const token = new TextEncoder().encode(crypto.randomUUID());
  const acquire = Effect.gen(function* () {
    yield* confine(fs, root, path, target);
    yield* platform(
      path,
      fs.makeDirectory(dirname(target), {
        recursive: true,
        mode: DIRECTORY_MODE,
      }),
    );
    yield* platform(
      path,
      fs.writeFile(lock, token, { flag: "wx", mode: FILE_MODE }).pipe(
        Effect.tapError(() => breakStale(fs, lock)),
        Effect.retry({
          schedule: Schedule.spaced(LOCK_EVERY),
          times: LOCK_TRIES,
          while: (error) => error.reason._tag === "AlreadyExists",
        }),
      ),
    );
    return lock;
  });
  return Effect.acquireUseRelease(
    acquire,
    () => work,
    // Only a lock still ours: one taken over as stale is another writer's now.
    (held) =>
      fs.readFile(held).pipe(
        Effect.flatMap((content) =>
          new TextDecoder().decode(content) === new TextDecoder().decode(token)
            ? fs.remove(held, { force: true })
            : Effect.void,
        ),
        Effect.ignore,
      ),
  );
}
