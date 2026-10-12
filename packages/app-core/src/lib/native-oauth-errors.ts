/** Safe protocol failures never include authorization codes, tokens or provider response bodies. */
export class NativeOAuthError extends Error {
  constructor(
    readonly code:
      | "callback"
      | "expired"
      | "denied"
      | "network"
      | "provider"
      | "scope"
      | "storage"
      | "cleanup",
    readonly oauthError?: "invalid_grant",
  ) {
    super(
      {
        callback:
          "Authorization could not be matched or was already used; authorize this connector again",
        expired:
          "Authorization expired or the connector changed; authorize again",
        denied: "Provider authorization was declined",
        network:
          "The provider could not be reached from this browser; check its CORS policy and your connection",
        provider:
          "The provider did not return a valid public-browser authorization",
        scope:
          "Provider authorization did not grant the required selected permissions",
        storage:
          "Provider authorization could not be sealed; finish authorization cleanup before retrying",
        cleanup:
          "Provider authorization cleanup is still required; use the provider's authorization settings and retry",
      }[code],
    );
    this.name = "NativeOAuthError";
  }
}
