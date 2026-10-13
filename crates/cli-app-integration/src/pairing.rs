//! Browser pairing for CLI app-integration routes (ADR 0186 round 4).
//!
//! A page trades a one-time code from the terminal for a bearer that may call
//! `pending` and `respond` only when its `Origin` matches the bound origin.

use base64::Engine as _;
use rand_core::{OsRng, RngCore as _};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const PAIRING_CODE_PREFIX: &str = "opensesame-cli-app:v1:";
pub const CODE_TTL_SECS: u64 = 300;
pub const MAX_PENDING: usize = 8;
pub const MAX_PAIRED: usize = 16;
pub const MAX_LABEL_CHARS: usize = 80;

const SECRET_LEN: usize = 43;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum PairingError {
    #[error(
        "an origin is https://host[:port] or http://localhost:port, exactly as a browser sends it"
    )]
    InvalidOrigin,
    #[error("too many CLI app-integration pairings; unpair one first")]
    Full,
    #[error("no such pairing code")]
    Unknown,
    #[error("the pairing code expired")]
    Expired,
    #[error("the pairing code was issued for another origin, and is now spent")]
    WrongOrigin,
    #[error("confirm the pairing code in OpenSesame before exchanging")]
    NotConfirmed,
}

#[derive(Clone, Debug)]
struct Pending {
    code_sha256: String,
    origin: String,
    expires_at: u64,
    /// Set only after the unlocked PWA confirms the code (`confirm`).
    confirmation_binding_sha256: Option<String>,
}

#[derive(Clone, Debug)]
struct PairedPage {
    id: String,
    token_sha256: String,
    origin: String,
    paired_at: u64,
}

/// A bearer handed back once by [`CliAppIntegrationPairings::exchange`].
pub struct Issued {
    pub id: String,
    pub origin: String,
    pub token: String,
}

impl std::fmt::Debug for Issued {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Issued")
            .field("id", &self.id)
            .field("origin", &self.origin)
            .field("token", &"[redacted]")
            .finish()
    }
}

/// In-memory pairings held by the daemon (restarts clear them; re-pair in Pages).
#[derive(Clone, Debug, Default)]
pub struct CliAppIntegrationPairings {
    pending: Vec<Pending>,
    paired: Vec<PairedPage>,
}

#[must_use]
pub fn is_pairable_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if url.origin().ascii_serialization() != origin
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.scheme() {
        "https" => url.host_str().is_some_and(|host| !host.ends_with('.')),
        "http" => url.host_str() == Some("localhost") && url.port().is_some(),
        _ => false,
    }
}

fn secret() -> String {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

fn pairing_id() -> String {
    let mut raw = [0u8; 8];
    OsRng.fill_bytes(&mut raw);
    hex::encode(raw)
}

fn digest_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn find_digest<'a>(digests: impl Iterator<Item = &'a str>, digest: &str) -> Option<usize> {
    digests.enumerate().fold(None, |found, (index, candidate)| {
        if same(candidate, digest) {
            Some(index)
        } else {
            found
        }
    })
}

#[must_use]
pub fn is_secret_shaped(value: &str) -> bool {
    value.len() == SECRET_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The printed pairing code for Pages to parse.
#[must_use]
pub fn format_pairing_code(url: &str, code: &str, origin: &str, label: &str) -> String {
    #[derive(Serialize)]
    struct Wire<'a> {
        code: &'a str,
        label: String,
        origin: &'a str,
        url: &'a str,
    }
    let wire = Wire {
        code,
        label: label.trim().chars().take(MAX_LABEL_CHARS).collect(),
        origin,
        url: url.trim_end_matches('/'),
    };
    let json = serde_json::to_string(&wire).unwrap_or_default();
    format!(
        "{PAIRING_CODE_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
    )
}

impl CliAppIntegrationPairings {
    /// Record a one-time code for `origin`; the code is returned once.
    pub fn issue(&mut self, origin: &str, now: u64) -> Result<(String, u64), PairingError> {
        if !is_pairable_origin(origin) {
            return Err(PairingError::InvalidOrigin);
        }
        self.pending.retain(|p| p.expires_at > now);
        if self.pending.len() >= MAX_PENDING {
            return Err(PairingError::Full);
        }
        let code = secret();
        let expires_at = now + CODE_TTL_SECS;
        self.pending.push(Pending {
            code_sha256: digest_hex(&code),
            origin: origin.to_string(),
            expires_at,
            confirmation_binding_sha256: None,
        });
        Ok((code, expires_at))
    }

    /// Pages calls this after a person confirms the printed code while the vault is unlocked.
    pub fn confirm(
        &mut self,
        code: &str,
        origin: &str,
        page_binding: &str,
        now: u64,
    ) -> Result<(), PairingError> {
        if !is_secret_shaped(page_binding) {
            return Err(PairingError::Unknown);
        }
        self.pending.retain(|p| p.expires_at > now);
        let digest = digest_hex(code);
        let index = find_digest(self.pending.iter().map(|p| p.code_sha256.as_str()), &digest)
            .filter(|_| is_secret_shaped(code))
            .ok_or(PairingError::Unknown)?;
        let pending = &mut self.pending[index];
        if pending.expires_at <= now {
            return Err(PairingError::Expired);
        }
        if pending.origin != origin {
            return Err(PairingError::WrongOrigin);
        }
        pending.confirmation_binding_sha256 = Some(digest_hex(page_binding));
        Ok(())
    }

    pub fn exchange(
        &mut self,
        code: &str,
        origin: &str,
        page_binding: &str,
        now: u64,
    ) -> Result<Issued, PairingError> {
        let digest = digest_hex(code);
        let found = find_digest(self.pending.iter().map(|p| p.code_sha256.as_str()), &digest);
        let Some(index) = found.filter(|_| is_secret_shaped(code)) else {
            return Err(PairingError::Unknown);
        };
        if !is_secret_shaped(page_binding) {
            return Err(PairingError::NotConfirmed);
        }
        let expected_binding = self.pending[index]
            .confirmation_binding_sha256
            .as_deref()
            .ok_or(PairingError::NotConfirmed)?;
        if !same(expected_binding, digest_hex(page_binding).as_str()) {
            return Err(PairingError::WrongOrigin);
        }
        if self.pending[index].expires_at > now
            && self.pending[index].origin == origin
            && self.paired.len() >= MAX_PAIRED
        {
            return Err(PairingError::Full);
        }
        let pending = self.pending.remove(index);
        self.pending.retain(|p| p.expires_at > now);
        if pending.expires_at <= now {
            return Err(PairingError::Expired);
        }
        if pending.origin != origin {
            return Err(PairingError::WrongOrigin);
        }
        let issued = Issued {
            id: pairing_id(),
            origin: pending.origin,
            token: secret(),
        };
        self.paired.push(PairedPage {
            id: issued.id.clone(),
            token_sha256: digest_hex(&issued.token),
            origin: issued.origin.clone(),
            paired_at: now,
        });
        Ok(issued)
    }

    #[must_use]
    pub fn authorizes(&self, token: &str, origin: &str) -> bool {
        if !is_secret_shaped(token) {
            return false;
        }
        let digest = digest_hex(token);
        self.paired.iter().any(|page| {
            page.origin == origin && same(page.token_sha256.as_str(), digest.as_str())
        })
    }

    #[must_use]
    pub fn admits_origin(&self, origin: &str, now: u64) -> bool {
        self.pending.iter().any(|p| p.origin == origin && p.expires_at > now)
            || self.paired.iter().any(|p| p.origin == origin)
    }

    #[must_use]
    pub fn paired_len(&self) -> usize {
        self.paired.len()
    }

    pub fn revoke_token(&mut self, origin: &str, token_digest_hex: &str) {
        self.paired.retain(|page| {
            !(page.origin == origin && same(page.token_sha256.as_str(), token_digest_hex))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchange_without_confirm_is_refused() {
        let mut pairings = CliAppIntegrationPairings::default();
        let origin = "http://localhost:5180";
        let now = 1_000;
        let (code, _) = pairings.issue(origin, now).unwrap();
        let binding = secret();
        assert!(matches!(
            pairings.exchange(&code, origin, &binding, now),
            Err(PairingError::NotConfirmed)
        ));
    }

    #[test]
    fn confirm_then_exchange_mints_bearer() {
        let mut pairings = CliAppIntegrationPairings::default();
        let origin = "http://localhost:5180";
        let now = 1_000;
        let (code, _) = pairings.issue(origin, now).unwrap();
        let binding = secret();
        pairings.confirm(&code, origin, &binding, now).unwrap();
        let issued = pairings.exchange(&code, origin, &binding, now).unwrap();
        assert!(is_secret_shaped(&issued.token));
        assert!(pairings.authorizes(&issued.token, origin));
    }
}
