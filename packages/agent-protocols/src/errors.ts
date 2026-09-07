import type { JsonObject } from "@opensesame/os-domain";

interface AgentAuthErrorBody {
  error: string;
  error_description?: string;
}

export class AgentAuthError extends Error {
  readonly error: string;
  readonly status: number;
  readonly errorDescription?: string;
  readonly extras?: JsonObject;

  constructor(
    error: string,
    status: number,
    errorDescription?: string,
    extras?: JsonObject,
  ) {
    super(errorDescription ?? error);
    this.name = "AgentAuthError";
    this.error = error;
    this.status = status;
    if (errorDescription !== undefined)
      this.errorDescription = errorDescription;
    if (extras !== undefined) this.extras = extras;
  }

  toJSON() {
    const result: AgentAuthErrorBody = { error: this.error };
    if (this.errorDescription) result.error_description = this.errorDescription;
    return { ...result, ...this.extras };
  }
}

export function agentAuthError(
  error: string,
  status: number,
  errorDescription?: string,
  extras?: JsonObject,
): AgentAuthError {
  return new AgentAuthError(error, status, errorDescription, extras);
}
