/**
 * The emulated secret file store (ADR 0182): a map of paths to bytes, for a
 * browser with no real file store and for every test. It keeps the contract
 * the disk and the network keep — whole-file replacement, revision checks,
 * sorted listings, the same path rule — so code written against it is code
 * written against them.
 */
import { Effect } from "effect";
import { SecretFsConflict, SecretFsNotFound } from "./errors.js";
import { checkWriteOwner } from "./files-owner.js";
import { checkPath, revisionOf } from "./files.js";
import type { SecretFiles } from "./files.js";
import type { WriteOptions } from "./files.js";

export type MemorySecretFiles = SecretFiles & {
  /** What is stored now, for a test or a persistence hook to look at. */
  readonly snapshot: () => ReadonlyMap<string, Uint8Array>;
};

export function makeMemorySecretFiles(
  initial: Iterable<readonly [string, Uint8Array]> = [],
): MemorySecretFiles {
  const stored = new Map<string, Uint8Array>();
  for (const [path, bytes] of initial) stored.set(path, bytes.slice());

  const read: SecretFiles["read"] = (path) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      const bytes = stored.get(path);
      if (bytes === undefined) return yield* new SecretFsNotFound({ path });
      return { bytes: bytes.slice(), revision: revisionOf(bytes) };
    });

  const write = (
    path: string,
    bytes: Uint8Array,
    options?: WriteOptions,
    check?: () => void,
  ) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      const current = stored.get(path);
      const actual = current === undefined ? null : revisionOf(current);
      if (options?.ifRevision !== undefined && options.ifRevision !== actual) {
        return yield* new SecretFsConflict({
          path,
          expected: options.ifRevision,
          actual,
        });
      }
      yield* checkWriteOwner(path, check);
      stored.set(path, bytes.slice());
      return revisionOf(bytes);
    });

  const remove: SecretFiles["remove"] = (path) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      stored.delete(path);
    });

  const list: SecretFiles["list"] = (prefix) =>
    Effect.gen(function* () {
      const under = yield* checkPath(prefix, { allowEmpty: true });
      return [...stored.keys()]
        .filter(
          (path) =>
            under === "" || path === under || path.startsWith(`${under}/`),
        )
        .sort();
    });

  return {
    read,
    write,
    writeGuarded: (path, bytes, check, options) =>
      write(path, bytes, options, check),
    remove,
    list,
    snapshot: () => new Map(stored),
  };
}
