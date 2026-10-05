//! Every way a tailnet admin call can fail, and the status and stable code a
//! caller sees for each. No variant carries a credential, a token or a key:
//! an upstream message is kept only when Tailscale explains a refusal of the
//! request itself, and it is trimmed and stripped of anything key-shaped.

/// Why a call did not happen, or what Tailscale said instead.
#[derive(Debug, thiserror::Error)]
pub enum AdminError {
    /// `opensesame tailnet connect` has not been run, or was undone.
    #[error("no tailnet is connected on this daemon")]
    NotConnected,
    /// The request failed validation before anything was sent.
    #[error("invalid request: {0}")]
    Invalid(&'static str),
    /// An auth key minted through an OAuth client must carry tags.
    #[error("an auth key minted through an OAuth client must carry tags")]
    TagsRequired,
    /// Tailscale refused the credential (expired token, missing scope).
    #[error("Tailscale refused the credential ({status})")]
    CredentialRefused { status: u16 },
    /// No such device or key on the tailnet.
    #[error("no such device or key")]
    NotFound,
    /// Tailscale understood the request and refused it.
    #[error("Tailscale refused the request: {message}")]
    Rejected { message: String },
    /// Tailscale asked us to slow down.
    #[error("Tailscale is rate limiting this tailnet")]
    RateLimited { retry_after: u64 },
    /// Tailscale did not answer, or answered with something unreadable.
    #[error("Tailscale is unavailable: {0}")]
    Unavailable(String),
    /// A file under the admin directory could not be written or read.
    #[error("storage failed: {0}")]
    Storage(#[from] std::io::Error),
    /// A file under the admin directory is not one this build wrote.
    #[error("the tailnet admin state is unreadable: {0}")]
    Unreadable(String),
    /// A pairing code was unknown, expired, or for another origin.
    #[error("pairing refused")]
    PairingRefused,
    /// Too many pairings or codes waiting.
    #[error("too many tailnet pairings; unpair one first")]
    Full,
    /// No config or home directory to keep the state in.
    #[error("no directory to keep tailnet admin state in")]
    NoDirectory,
}

impl AdminError {
    /// The HTTP status a route answers with.
    #[must_use]
    pub fn status(&self) -> u16 {
        match self {
            Self::NotConnected | Self::NoDirectory => 503,
            Self::Invalid(_) | Self::TagsRequired => 400,
            Self::CredentialRefused { .. } | Self::Unavailable(_) => 502,
            Self::NotFound => 404,
            Self::Rejected { .. } => 422,
            Self::RateLimited { .. } => 429,
            Self::Storage(_) | Self::Unreadable(_) => 500,
            Self::PairingRefused => 403,
            Self::Full => 409,
        }
    }

    /// The stable code a route answers with; a page branches on this.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConnected => "tailnet_not_connected",
            Self::NoDirectory => "tailnet_admin_unavailable",
            Self::Invalid(code) => code,
            Self::TagsRequired => "tags_required",
            Self::CredentialRefused { .. } => "tailscale_credential_refused",
            Self::Unavailable(_) => "tailscale_unavailable",
            Self::NotFound => "not_found",
            Self::Rejected { .. } => "tailscale_rejected",
            Self::RateLimited { .. } => "rate_limited",
            Self::Storage(_) => "storage_failed",
            Self::Unreadable(_) => "tailnet_admin_unreadable",
            Self::PairingRefused => "pairing_refused",
            Self::Full => "too_many_pairings",
        }
    }

    /// What a page may show beside the code: Tailscale's own explanation of
    /// a refused request, or nothing.
    #[must_use]
    pub fn detail(&self) -> Option<&str> {
        match self {
            Self::Rejected { message } => Some(message),
            _ => None,
        }
    }
}

/// Keep at most 200 characters of an upstream message, and drop it entirely
/// if it carries anything that looks like a Tailscale key.
#[must_use]
pub(crate) fn safe_message(raw: &str) -> String {
    if raw.contains("tskey-") {
        return "Tailscale refused the request.".to_string();
    }
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).take(200).collect();
    if cleaned.trim().is_empty() {
        "Tailscale refused the request.".to_string()
    } else {
        cleaned.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_carrying_a_key_is_never_repeated() {
        assert_eq!(
            safe_message("key tskey-auth-abc123 is invalid"),
            "Tailscale refused the request."
        );
        assert_eq!(safe_message("  tags invalid\n"), "tags invalid");
        assert_eq!(safe_message(&"x".repeat(500)).len(), 200);
        assert_eq!(safe_message(""), "Tailscale refused the request.");
    }

    #[test]
    fn every_error_has_a_stable_status_and_code() {
        let all = [
            AdminError::NotConnected,
            AdminError::Invalid("invalid_name"),
            AdminError::TagsRequired,
            AdminError::CredentialRefused { status: 403 },
            AdminError::NotFound,
            AdminError::Rejected {
                message: "no".into(),
            },
            AdminError::RateLimited { retry_after: 3 },
            AdminError::Unavailable("timeout".into()),
            AdminError::PairingRefused,
            AdminError::Full,
        ];
        let statuses: Vec<_> = all.iter().map(AdminError::status).collect();
        assert_eq!(statuses, [503, 400, 400, 502, 404, 422, 429, 502, 403, 409]);
        assert_eq!(all[1].code(), "invalid_name");
        assert_eq!(all[5].detail(), Some("no"));
        assert_eq!(all[0].detail(), None);
    }
}
