//! Invoke-through error type (ADR 0048 D6/D7).
//!
//! Every variant is safe to log and to return to the operator: none of them
//! carries credential bytes, and [`crate::TokenSource`] implementations are
//! contractually bound to keep tokens out of [`InvokeError::TokenUnavailable`]
//! messages. The unit tests pin this with a canary token.

/// One failure class per fence the invoke-through path enforces.
#[derive(Debug, thiserror::Error)]
pub enum InvokeError {
    /// The URL did not parse, or carried userinfo (which must never be
    /// honored — userinfo is a credential smuggled into log lines).
    #[error("invalid request URL")]
    InvalidUrl,
    /// No invoke-through adapter exists for this provider in this build.
    #[error("no invoke-through adapter for provider `{0}`")]
    UnsupportedProvider(String),
    /// The URL's host is not on the provider's egress allowlist. Raised
    /// before any connection attempt (ADR 0032 §3, ADR 0048 I8).
    #[error("host `{host}` is not on the `{provider}` egress allowlist")]
    EgressDenied { provider: String, host: String },
    /// Plain HTTP is refused outside the explicit loopback test mode.
    #[error("https is required for invoke-through (scheme `{0}` given)")]
    HttpsRequired(String),
    /// Only idempotent-class and body methods a human CLI would issue.
    #[error("method `{0}` is not allowed for invoke-through")]
    MethodNotAllowed(String),
    /// Request headers are allowlisted (accept, content-type, user-agent) so
    /// a caller can never inject `authorization` or a cookie jar.
    #[error("header `{0}` is not on the invoke-through request allowlist")]
    HeaderNotAllowed(String),
    #[error("request body exceeds the {cap} byte cap")]
    RequestBodyTooLarge { cap: usize },
    #[error("upstream response exceeds the {cap} byte cap")]
    ResponseTooLarge { cap: usize },
    /// The source tool could not produce a credential. The message must be a
    /// failure *class* (timeout, exit status), never tool output.
    #[error("credential acquisition failed: {0}")]
    TokenUnavailable(String),
    /// The acquired credential could not be encoded into a header value.
    /// Carries no detail: any detail would describe the token.
    #[error("the acquired credential is not a usable header value")]
    MalformedToken,
    /// Transport failure talking to the allowlisted host. The message may
    /// name the host (receipts record it anyway) but never a credential.
    #[error("upstream transport failed: {0}")]
    Transport(String),
    #[error("upstream call timed out")]
    Timeout,
}
