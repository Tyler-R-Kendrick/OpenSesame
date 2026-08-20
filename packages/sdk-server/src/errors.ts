/** Authentication failure (401) — identity could not be established. */
export class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Authorization failure (403) — identity known but access denied. */
export class AuthorizationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthorizationError";
    this.code = code;
  }
}
