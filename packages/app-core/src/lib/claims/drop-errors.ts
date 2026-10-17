/** Errors shared by drop creation, transport and portable opening. */

import type { DropRefusalCode } from "@opensesame/ceremony-kit";

export type DropTransportErrorCode =
  | DropRefusalCode
  | "refused"
  | "limit_exceeded"
  | "corrupt"
  | "invalid_token"
  | "tampered";

export class DropTransportError extends Error {
  readonly code: DropTransportErrorCode;
  /** Wrong-code refusals only: tries remaining after this one. */
  readonly attemptsLeft?: number | undefined;

  constructor(
    code: DropTransportErrorCode,
    message: string,
    attemptsLeft?: number,
  ) {
    super(message);
    this.name = "DropTransportError";
    this.code = code;
    this.attemptsLeft = attemptsLeft;
  }
}

export type DropErrorCode =
  | "payload_too_large"
  | "invalid_manifest"
  | "invalid_key"
  | DropTransportErrorCode;

export class DropError extends Error {
  constructor(
    readonly code: DropErrorCode,
    message: string,
    /** Wrong-code refusals only: tries remaining after this one. */
    readonly attemptsLeft?: number,
  ) {
    super(message);
    this.name = "DropError";
  }
}
