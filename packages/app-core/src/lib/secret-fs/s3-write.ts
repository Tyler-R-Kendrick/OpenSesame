/** Conditional S3 writes retain the original owner through preflight and actual request dispatch. */
import { Effect } from "effect";
import { SecretFsConflict, SecretFsRejected } from "./errors.js";
import type { SecretFsError } from "./errors.js";
import { checkWriteOwner } from "./files-owner.js";
import { checkPath, revisionOf } from "./files.js";
import type { SecretFiles } from "./files.js";
import type { Wire } from "./s3.js";

const unquote = (etag: string | null): string | null =>
  etag === null ? null : etag.replace(/^W\//, "");

/** What the object is now, for a conflict to name and a conditional put to hold. */
const currentOf = (
  wire: Wire,
  path: string,
  refusal: (path: string, status: number) => SecretFsError,
  check?: () => void,
) =>
  Effect.gen(function* () {
    const response = yield* wire.call({
      method: "GET",
      path,
      beforeCommit: check,
    });
    if (response.status === 404) return null;
    if (!response.ok) return yield* refusal(path, response.status);
    const bytes = response.bytes;
    yield* wire.current(path);
    return {
      etag: unquote(response.etag),
      revision: revisionOf(bytes),
    };
  });

export const s3Write =
  (
    wire: Wire,
    refusal: (path: string, status: number) => SecretFsError,
    check?: () => void,
  ): SecretFiles["write"] =>
  (path, bytes, options) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      yield* checkWriteOwner(path, check);
      yield* wire.current(path);
      if (bytes.byteLength > wire.max) {
        return yield* new SecretFsRejected({
          path,
          kind: "invalid-path",
          reason: "the file is larger than a store holds",
        });
      }
      const expected = options?.ifRevision;
      const headers = new Headers({
        "content-type": "application/octet-stream",
      });
      const conflict = (actual: string | null) =>
        new SecretFsConflict({ path, expected: expected ?? null, actual });

      if (expected === null) headers.set("if-none-match", "*");
      else if (expected !== undefined) {
        const current = yield* currentOf(wire, path, refusal, check);
        yield* wire.current(path);
        yield* checkWriteOwner(path, check);
        if (current === null || current.revision !== expected) {
          return yield* conflict(current?.revision ?? null);
        }
        if (current.etag !== null) headers.set("if-match", current.etag);
      }
      const response = yield* wire.call({
        method: "PUT",
        path,
        headers,
        body: bytes,
        beforeCommit: check,
      });
      yield* checkWriteOwner(path, check);
      // 412 is a failed precondition; 409 is a rival conditional write in flight.
      if (response.status === 412 || response.status === 409) {
        const now = yield* currentOf(wire, path, refusal, check).pipe(
          Effect.orElseSucceed(() => null),
        );
        yield* wire.current(path);
        return yield* conflict(now?.revision ?? null);
      }
      if (!response.ok) return yield* refusal(path, response.status);
      const revision = revisionOf(bytes);
      yield* wire.current(path);
      return revision;
    });
