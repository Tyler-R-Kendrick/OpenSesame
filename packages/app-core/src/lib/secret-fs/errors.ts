/**
 * What a secret file store can fail with (ADR 0182). Four outcomes, because a
 * caller does one of four things: treat the file as absent, re-read and
 * decide again, try later, or give up. A backend maps its own failures onto
 * these — a `PlatformError`, an HTTP status, a lost socket — so nothing above
 * the store ever branches on which backend it has.
 */
import { Data } from "effect";

/** There is no file at the path. */
export class SecretFsNotFound extends Data.TaggedError("SecretFsNotFound")<{
  readonly path: string;
}> {
  override get message(): string {
    return `There is no file at "${this.path}".`;
  }
}

/**
 * A write named the revision it expected and the file was at another. `actual`
 * is `null` when the file is absent, so a caller that lost a race can tell a
 * rival write from a deletion without a second read.
 */
export class SecretFsConflict extends Data.TaggedError("SecretFsConflict")<{
  readonly path: string;
  readonly expected: string | null;
  readonly actual: string | null;
}> {
  override get message(): string {
    return `"${this.path}" was changed by someone else since it was read.`;
  }
}

/** The store could not be reached or did not answer in time: worth another try. */
export class SecretFsUnavailable extends Data.TaggedError(
  "SecretFsUnavailable",
)<{
  readonly path: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `The file store could not be reached for "${this.path}": ${this.reason}.`;
  }
}

export type SecretFsRejection = "invalid-path" | "permission" | "corrupt";

/** The store refused, and asking again will not change its answer. */
export class SecretFsRejected extends Data.TaggedError("SecretFsRejected")<{
  readonly path: string;
  readonly kind: SecretFsRejection;
  readonly reason: string;
}> {
  override get message(): string {
    return `"${this.path}" was refused: ${this.reason}.`;
  }
}

export type SecretFsError =
  | SecretFsNotFound
  | SecretFsConflict
  | SecretFsUnavailable
  | SecretFsRejected;

/** Only an unreachable store is retried; every other answer is final. */
export function isTransient(error: SecretFsError): boolean {
  return error._tag === "SecretFsUnavailable";
}
