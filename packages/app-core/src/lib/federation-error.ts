/** Failure of a federated sign-in, named so callers can branch on `code`. */
export class FederationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FederationError";
    this.code = code;
  }
}
