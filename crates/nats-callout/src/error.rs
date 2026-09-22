//! Stable, non-secret failure codes. Every failure is a deny; the code is
//! what reaches the audit trail and the signed `error` response.

/// Why a callout could not be granted. [`CalloutError::code`] is the wire
/// contract; the `Display` text may change, the codes may not.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CalloutError {
    #[error("malformed authorization request: {0}")]
    MalformedRequest(String),
    #[error("request JWT algorithm or type is not ed25519-nkey/JWT")]
    UnsupportedAlgorithm,
    #[error("request signature does not verify against the issuing server key")]
    BadSignature,
    #[error("request issuer is not a server nkey")]
    IssuerNotServer,
    #[error("request was signed by a server this deployment does not trust")]
    ServerUnknown,
    #[error("request audience is not this callout account")]
    AudienceMismatch,
    #[error("request subject is not this deployment's callout issuer")]
    SubjectNotCallout,
    #[error("request does not name a valid one-time user nkey")]
    UserNkeyInvalid,
    #[error("request issuer is not the server it names in server_id")]
    ServerIdMismatch,
    #[error("request is outside its time window")]
    OutsideWindow,
    #[error("request nonce, server or user key disagree with the envelope")]
    EnvelopeMismatch,
    #[error("request is sealed but no xkey is configured")]
    XkeyRequired,
    #[error("sealed request could not be opened")]
    XkeyOpenFailed,
    #[error("request carries no verifiable end-user evidence")]
    EvidenceMissing,
    #[error("Host decision endpoint unreachable or timed out")]
    HostUnreachable,
    #[error("Host decision endpoint answered with an error")]
    HostError,
    #[error("Host response does not echo the request it was asked about")]
    ResponseMismatch,
    #[error("response could not be signed")]
    SigningFailed,
    #[error("bridge configuration is malformed: {0}")]
    MalformedConfiguration(String),
}

impl CalloutError {
    /// Stable machine code: the `snake_case` spelling of the variant.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::MalformedRequest(_) => "malformed_request",
            Self::UnsupportedAlgorithm => "unsupported_algorithm",
            Self::BadSignature => "bad_signature",
            Self::IssuerNotServer => "issuer_not_server",
            Self::ServerUnknown => "server_unknown",
            Self::AudienceMismatch => "audience_mismatch",
            Self::SubjectNotCallout => "subject_not_callout",
            Self::UserNkeyInvalid => "user_nkey_invalid",
            Self::ServerIdMismatch => "server_id_mismatch",
            Self::OutsideWindow => "outside_window",
            Self::EnvelopeMismatch => "envelope_mismatch",
            Self::XkeyRequired => "xkey_required",
            Self::XkeyOpenFailed => "xkey_open_failed",
            Self::EvidenceMissing => "evidence_missing",
            Self::HostUnreachable => "host_unreachable",
            Self::HostError => "host_error",
            Self::ResponseMismatch => "response_mismatch",
            Self::SigningFailed => "signing_failed",
            Self::MalformedConfiguration(_) => "malformed_configuration",
        }
    }
}

pub(crate) fn malformed(msg: impl Into<String>) -> CalloutError {
    CalloutError::MalformedRequest(msg.into())
}

pub(crate) fn misconfigured(msg: impl Into<String>) -> CalloutError {
    CalloutError::MalformedConfiguration(msg.into())
}
