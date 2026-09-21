/** Typed failures for root-protection parse/crypto/lifecycle (C04). */

export type ProtectionErrorCode =
  | "unsupported_version"
  | "unknown_critical_field"
  | "duplicate_protector_id"
  | "duplicate_json_key"
  | "oversized_manifest"
  | "oversized_record"
  | "too_many_records"
  | "malformed_encoding"
  | "invalid_nonce"
  | "invalid_tag"
  | "invalid_key_length"
  | "context_mismatch"
  | "manifest_auth_failed"
  | "capsule_auth_failed"
  | "kdf_bounds"
  | "stale_operation"
  | "pending_authorization"
  | "last_verified_path"
  | "bootstrap_cycle"
  | "revision_conflict"
  | "canceled"
  | "unavailable"
  | "unsupported_runtime"
  | "provider_denied"
  | "ssrf_blocked"
  | "enrollment_proof_failed"
  | "agent_forbidden";

export class ProtectionError extends Error {
  readonly code: ProtectionErrorCode;

  constructor(code: ProtectionErrorCode, message: string) {
    super(message);
    this.name = "ProtectionError";
    this.code = code;
  }
}
