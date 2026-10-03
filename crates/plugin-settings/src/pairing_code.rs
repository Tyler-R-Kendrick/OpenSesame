//! The printed plugin pairing code and the shapes both of its secrets take
//! (ADR 0150 §7): what `opensesame plugins pair` prints, which origins may be
//! named in it, and the one-time code and bearer, 32 random bytes each.
//! `spec/conformance/plugin-pairing.json` pins the wire form for Pages too.

use base64::Engine as _;
use rand_core::{OsRng, RngCore as _};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// What a plugin pairing code starts with.
pub const PAIRING_CODE_PREFIX: &str = "opensesame-plugins:v1:";
/// Longest label a pairing code carries.
pub const MAX_LABEL_CHARS: usize = 80;
/// 32 random bytes, unpadded base64url.
const SECRET_LEN: usize = 43;

/// Seconds since the Unix epoch.
#[must_use]
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Exactly the origin a browser sends: `https://host[:port]`, or
/// `http://localhost:port` for a page served on this machine. No path, no
/// trailing slash, no user, no default port written out.
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

/// A code or bearer this module could have minted.
#[must_use]
pub fn is_secret_shaped(value: &str) -> bool {
    value.len() == SECRET_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
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

pub(crate) fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// The one entry whose digest is `digest`, scanning every entry either way.
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

/// The printed pairing code: where the daemon is, the one-time code, the
/// origin it is bound to and a label, as unpadded base64url JSON.
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
