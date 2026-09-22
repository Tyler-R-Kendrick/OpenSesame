/**
 * Deterministic failure codes for forwarded-evidence processing.
 *
 * Byte-identical twins of `IngressError::code()` in
 * `crates/ingress-evidence/src/error.rs`; the corpus under
 * `crates/ingress-evidence/fixtures/` pins each one for both parsers.
 */
export type IngressErrorCode =
  | "header_bytes_exceeded"
  | "leaf_missing"
  | "leaf_repeated"
  | "malformed_structured_field"
  | "not_byte_sequence"
  | "parameters_present"
  | "empty_item"
  | "certificate_too_large"
  | "chain_too_long"
  | "not_der_certificate"
  | "conflicting_leaf";

/** Which RFC 9440 field a problem was found in. */
export type IngressField = "client-cert" | "client-cert-chain";

/**
 * A forwarded-evidence rejection. The code is the contract; the message is
 * fixed text and never carries certificate bytes, subjects or header text.
 */
export class IngressEvidenceError extends Error {
  readonly code: IngressErrorCode;
  readonly field: IngressField | null;

  constructor(code: IngressErrorCode, field: IngressField | null) {
    super(field ? `${code} (${field})` : code);
    this.name = "IngressEvidenceError";
    this.code = code;
    this.field = field;
  }
}

export function ingressError(
  code: IngressErrorCode,
  field: IngressField | null = null,
): IngressEvidenceError {
  return new IngressEvidenceError(code, field);
}
