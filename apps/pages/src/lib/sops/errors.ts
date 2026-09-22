/**
 * Typed, redacted SOPS failures (B15). A message never carries document
 * text, key material, provider responses, or file names; `path` is the
 * cleartext key path SOPS itself leaves in the clear.
 */

export type SopsErrorCode =
  | "malformed_encoding"
  | "invalid_document"
  | "invalid_metadata"
  | "duplicate_key"
  | "unsupported_feature"
  | "unsupported_version"
  | "unsupported_identity"
  | "invalid_recipient"
  | "missing_identity"
  | "insufficient_groups"
  | "authentication_failed"
  | "provider_unavailable"
  | "provider_denied"
  | "unauthorized_policy"
  | "stale_session"
  | "canceled"
  | "resource_limit"
  | "persistence_failure";

export class SopsError extends Error {
  readonly code: SopsErrorCode;
  readonly path: readonly string[] | undefined;

  constructor(code: SopsErrorCode, message: string, path?: readonly string[]) {
    super(message);
    this.name = "SopsError";
    this.code = code;
    this.path = path;
  }
}

/** True when `caught` is a SopsError carrying `code`. */
export function isSopsError(caught: unknown, code?: SopsErrorCode): boolean {
  if (!(caught instanceof SopsError)) return false;
  return code === undefined || caught.code === code;
}

/**
 * Convert any thrown value into a SopsError without copying foreign message
 * text: parser and library exceptions can quote source bytes.
 */
export function redactError(
  caught: unknown,
  fallback: SopsErrorCode,
): SopsError {
  if (caught instanceof SopsError) return caught;
  if (caught instanceof DOMException && caught.name === "AbortError") {
    return new SopsError("canceled", "The SOPS operation was canceled.");
  }
  return new SopsError(fallback, describe(fallback));
}

const MESSAGES = {
  malformed_encoding: "The document contains a malformed encoding.",
  invalid_document:
    "The document is not a SOPS YAML or JSON document in the supported profile.",
  invalid_metadata: "The sops metadata block is malformed.",
  duplicate_key: "A mapping repeats a key.",
  unsupported_feature:
    "The document uses a feature outside the supported profile.",
  unsupported_version:
    "The document names a SOPS version this engine has not been tested against.",
  unsupported_identity: "The identity is not a supported age X25519 identity.",
  invalid_recipient: "A recipient is not a valid age recipient.",
  missing_identity: "No supplied identity opens any key group.",
  insufficient_groups: "Not enough distinct key groups could be opened.",
  authentication_failed: "The document failed authentication.",
  provider_unavailable:
    "A key provider could not be reached from this browser.",
  provider_denied: "A key provider refused the request.",
  unauthorized_policy: "The requested policy was not approved.",
  stale_session: "The session changed while the operation was pending.",
  canceled: "The SOPS operation was canceled.",
  resource_limit: "The document exceeds a resource limit.",
  persistence_failure: "The result could not be stored.",
} satisfies Record<SopsErrorCode, string>;

function describe(code: SopsErrorCode): string {
  // An unknown code can only arrive from an unsound call, but an error with
  // an empty message is worse than a vague one: say something.
  return MESSAGES[code] ?? "The SOPS operation failed.";
}
