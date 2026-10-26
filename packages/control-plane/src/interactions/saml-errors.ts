export type SamlAuthErrorCode =
  | "not_configured"
  | "metadata_unavailable"
  | "unknown_request"
  | "invalid_assertion"
  | "replayed_assertion";

export class SamlAuthError extends Error {
  constructor(
    readonly code: SamlAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SamlAuthError";
  }
}
