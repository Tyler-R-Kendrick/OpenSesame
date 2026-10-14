//! Pairing-code and origin helpers for CLI app-integration pairing (D6).

use base64::Engine as _;
use rand_core::{OsRng, RngCore as _};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::device_crypto::parse_verifying_key_spki_b64;
use crate::pairing::{ConfirmOutcome, Issued, MAX_LABEL_CHARS, PAIRING_CODE_PREFIX};

const SECRET_LEN: usize = 43;

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

pub(crate) fn secret() -> String {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

pub(crate) fn pairing_id() -> String {
    let mut raw = [0u8; 8];
    OsRng.fill_bytes(&mut raw);
    hex::encode(raw)
}

pub(crate) fn digest_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub(crate) fn registration_code() -> String {
    let n: u32 = OsRng.next_u32() % 1_000_000;
    format!("{n:06}")
}

pub(crate) fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

pub(crate) fn find_digest<'a>(
    digests: impl Iterator<Item = &'a str>,
    digest: &str,
) -> Option<usize> {
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

#[must_use]
pub fn is_device_public_key_shaped(value: &str) -> bool {
    parse_verifying_key_spki_b64(value).is_some()
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

impl std::fmt::Debug for Issued {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Issued")
            .field("id", &self.id)
            .field("origin", &self.origin)
            .field("token", &"[redacted]")
            .finish()
    }
}

impl std::fmt::Debug for ConfirmOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConfirmOutcome")
            .field("registration_code", &"[redacted]")
            .finish()
    }
}
