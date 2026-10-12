/**
 * The contract every secret file store keeps (ADR 0182): the browser's
 * emulation, a directory on disk and a privately hosted store reached over
 * HTTP are the same four operations with the same answers. The vault never
 * learns which one it was given, and `files.conformance.ts` is the one suite
 * each of them has to pass.
 *
 * A store holds opaque bytes at relative, slash-separated paths. What the
 * bytes are — sealed documents, a manifest — is `secret-docs.ts`'s business.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { Context, Effect } from "effect";
import { SecretFsRejected } from "./errors.js";
import type { SecretFsError } from "./errors.js";

/** A file's revision: the SHA-256 of its bytes, so every backend agrees on it. */
export type Revision = string;

export function revisionOf(bytes: Uint8Array): Revision {
  return bytesToHex(sha256(bytes));
}

export type FileRead = Readonly<{ bytes: Uint8Array; revision: Revision }>;

export type WriteOptions = Readonly<{
  /**
   * The revision the file must be at for the write to land; `null` means it
   * must not exist yet. Left out, the write replaces whatever is there.
   */
  ifRevision?: Revision | null;
}>;

export interface SecretFiles {
  /** Fails `SecretFsNotFound` when there is no file. */
  readonly read: (path: string) => Effect.Effect<FileRead, SecretFsError>;
  /**
   * Replace the file whole, or not at all: a reader sees the old bytes or the
   * new, never a mix, and a crash leaves one of them. Creates parent
   * directories. Fails `SecretFsConflict` when `ifRevision` does not hold.
   */
  readonly write: (
    path: string,
    bytes: Uint8Array,
    options?: WriteOptions,
  ) => Effect.Effect<Revision, SecretFsError>;
  /** Removes the file; a file that is already gone is not a failure. */
  readonly remove: (path: string) => Effect.Effect<void, SecretFsError>;
  /** Every file at or under `prefix` ("" for all), sorted, relative to the root. */
  readonly list: (
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>, SecretFsError>;
}

export const SecretFiles = Context.Service<SecretFiles, SecretFiles>(
  "opensesame/SecretFiles",
);

const NO_CHECK_OPTIONS: PathCheck = {};
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~+=@-]*$/;
const MAX_SEGMENT = 200;
const MAX_PATH = 900;
/** Where a backend stages a write; never a path a caller may name. */
export const STAGING_SUFFIX = ".part";
const RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function badSegment(segment: string): boolean {
  return (
    !SEGMENT.test(segment) ||
    segment.length > MAX_SEGMENT ||
    segment.endsWith(".") ||
    segment.endsWith(STAGING_SUFFIX) ||
    RESERVED_BASE.test(segment.split(".")[0] ?? "")
  );
}

/**
 * A path is safe for every backend or for none: relative, `/`-separated, no
 * `.` or `..`, no segment a Windows disk, a shell or a staging file would
 * misread. One rule here is what lets the same vault move between a browser,
 * a Linux directory and a NAS share.
 */
export type PathCheck = Readonly<{ allowEmpty?: boolean }>;

export function checkPath(
  path: string,
  options: PathCheck = NO_CHECK_OPTIONS,
): Effect.Effect<string, SecretFsRejected> {
  const trimmed =
    options.allowEmpty && path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "" && options.allowEmpty) return Effect.succeed("");
  const refuse = (reason: string) =>
    Effect.fail(new SecretFsRejected({ path, kind: "invalid-path", reason }));
  if (trimmed === "" || trimmed.length > MAX_PATH) {
    return refuse("a path is 1 to 900 characters");
  }
  const bad = trimmed.split("/").find(badSegment);
  return bad === undefined
    ? Effect.succeed(trimmed)
    : refuse(`"${bad}" is not a name every store can hold`);
}
