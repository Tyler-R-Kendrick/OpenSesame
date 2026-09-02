export class AgentAuthError extends Error {
  readonly error: string;
  readonly status: number;
  readonly errorDescription?: string;
  readonly extras?: Record<string, unknown>;

  constructor(
    error: string,
    status: number,
    errorDescription?: string,
    extras?: Record<string, unknown>,
  ) {
    super(errorDescription ?? error);
    this.name = "AgentAuthError";
    this.error = error;
    this.status = status;
    if (errorDescription !== undefined)
      this.errorDescription = errorDescription;
    if (extras !== undefined) this.extras = extras;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.error,
      ...(this.errorDescription
        ? { error_description: this.errorDescription }
        : {}),
      ...this.extras,
    };
  }
}

export function agentAuthError(
  error: string,
  status: number,
  errorDescription?: string,
  extras?: Record<string, unknown>,
): AgentAuthError {
  return new AgentAuthError(error, status, errorDescription, extras);
}
