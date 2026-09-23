/**
 * WAL-B08 — unsupported static security/origin profiles refuse root operations
 * while metadata / local approval UX may still render.
 */

export type StaticWalletProfile =
  | "secure_context_https"
  | "secure_context_localhost"
  | "insecure_http"
  | "opaque_origin";

export type RootOperationRefusal = {
  readonly ok: false;
  readonly code: "UNSUPPORTED_STATIC_SECURITY_PROFILE";
  readonly detail: string;
};

export type RootOperationAllow = { readonly ok: true };

export function assessRootWalletOperation(
  profile: StaticWalletProfile,
): RootOperationAllow | RootOperationRefusal {
  if (
    profile === "secure_context_https" ||
    profile === "secure_context_localhost"
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "UNSUPPORTED_STATIC_SECURITY_PROFILE",
    detail:
      "Root wallet key operations require a secure context; metadata and local approval UI may still render.",
  };
}
