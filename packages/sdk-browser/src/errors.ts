/**
 * A claim request the server refused, carrying its status so callers can tell a
 * claim that is finished with from one that might succeed on a retry: 401/404
 * mean this bearer will never work again, 410 that the claim expired, 409/422
 * that it has moved on, while a network failure throws a plain Error.
 */
export class ClaimRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ClaimRequestError";
    this.status = status;
  }

  /** Whether retrying with the same bearer could ever succeed. */
  get spent(): boolean {
    return this.status !== 429 && this.status < 500;
  }
}
