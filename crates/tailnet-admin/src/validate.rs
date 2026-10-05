//! What the daemon checks before it sends anything to Tailscale (ADR 0168 §4).
//! Each check returns the stable code a page shows, so a bad request never
//! costs an upstream call or reaches the audit trail as a change.

use std::net::IpAddr;

use crate::AdminError;

/// Tags on one device or one key.
pub const MAX_TAGS: usize = 50;
/// Enabled routes on one device.
pub const MAX_ROUTES: usize = 256;
/// Shortest auth key lifetime offered: one hour.
pub const MIN_KEY_EXPIRY_SECS: u64 = 3600;
/// Longest: Tailscale's own 90 days.
pub const MAX_KEY_EXPIRY_SECS: u64 = 90 * 24 * 3600;

/// A device id (`nodeId` or the legacy numeric id) or a key id.
///
/// # Errors
///
/// `Invalid("invalid_id")`.
pub fn id(raw: &str) -> Result<&str, AdminError> {
    if (1..=64).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(raw)
    } else {
        Err(AdminError::Invalid("invalid_id"))
    }
}

fn is_label(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=63).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

/// A machine name: one lowercase DNS label, or empty to reset it to the
/// device's hostname.
///
/// # Errors
///
/// `Invalid("invalid_name")`.
pub fn name(raw: &str) -> Result<String, AdminError> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() || is_label(&trimmed) {
        Ok(trimmed)
    } else {
        Err(AdminError::Invalid("invalid_name"))
    }
}

/// Tags: each `tag:` and a lowercase label starting with a letter, no
/// duplicates, at most [`MAX_TAGS`]. Returned sorted.
///
/// # Errors
///
/// `Invalid("invalid_tags")`.
pub fn tags(raw: &[String]) -> Result<Vec<String>, AdminError> {
    if raw.len() > MAX_TAGS {
        return Err(AdminError::Invalid("invalid_tags"));
    }
    let mut out = Vec::with_capacity(raw.len());
    for tag in raw {
        let tag = tag.trim();
        let ok = tag
            .strip_prefix("tag:")
            .is_some_and(|rest| is_label(rest) && rest.as_bytes()[0].is_ascii_lowercase());
        if !ok || out.iter().any(|t: &String| t == tag) {
            return Err(AdminError::Invalid("invalid_tags"));
        }
        out.push(tag.to_string());
    }
    out.sort();
    Ok(out)
}

/// One route: an IPv4 or IPv6 prefix in canonical form (no host bits set),
/// so what the page shows is exactly what Tailscale stores.
fn route(raw: &str) -> Option<String> {
    let (addr, len) = raw.trim().split_once('/')?;
    let addr: IpAddr = addr.parse().ok()?;
    let len: u8 = len.parse().ok()?;
    let canonical = match addr {
        IpAddr::V4(v4) if len <= 32 => {
            let mask = u32::MAX.checked_shl(32 - u32::from(len)).unwrap_or(0);
            IpAddr::V4((u32::from(v4) & mask).into())
        }
        IpAddr::V6(v6) if len <= 128 => {
            let mask = u128::MAX.checked_shl(128 - u32::from(len)).unwrap_or(0);
            IpAddr::V6((u128::from(v6) & mask).into())
        }
        _ => return None,
    };
    (canonical == addr).then(|| format!("{addr}/{len}"))
}

/// Enabled routes: canonical prefixes, no duplicates, at most [`MAX_ROUTES`].
///
/// # Errors
///
/// `Invalid("invalid_routes")`.
pub fn routes(raw: &[String]) -> Result<Vec<String>, AdminError> {
    if raw.len() > MAX_ROUTES {
        return Err(AdminError::Invalid("invalid_routes"));
    }
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for entry in raw {
        let parsed = route(entry).ok_or(AdminError::Invalid("invalid_routes"))?;
        if out.contains(&parsed) {
            return Err(AdminError::Invalid("invalid_routes"));
        }
        out.push(parsed);
    }
    Ok(out)
}

/// What a page asks for when it mints an auth key.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyRequest {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub reusable: bool,
    #[serde(default)]
    pub ephemeral: bool,
    #[serde(default)]
    pub preauthorized: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    pub expiry_seconds: u64,
}

/// A key request Tailscale will accept. `tags_required` is the caller's to
/// enforce: only it knows whether the credential is an OAuth client.
///
/// # Errors
///
/// `invalid_description`, `invalid_expiry`, `invalid_tags`, or
/// `TagsRequired`.
pub fn key_request(raw: &KeyRequest, tags_required: bool) -> Result<KeyRequest, AdminError> {
    let description = raw.description.trim().to_string();
    let described = description.len() <= 50
        && description
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'-');
    if !described {
        return Err(AdminError::Invalid("invalid_description"));
    }
    if !(MIN_KEY_EXPIRY_SECS..=MAX_KEY_EXPIRY_SECS).contains(&raw.expiry_seconds) {
        return Err(AdminError::Invalid("invalid_expiry"));
    }
    let tags = tags(&raw.tags)?;
    if tags_required && tags.is_empty() {
        return Err(AdminError::TagsRequired);
    }
    Ok(KeyRequest {
        description,
        reusable: raw.reusable,
        ephemeral: raw.ephemeral,
        preauthorized: raw.preauthorized,
        tags,
        expiry_seconds: raw.expiry_seconds,
    })
}

#[cfg(test)]
#[path = "validate_tests.rs"]
mod tests;
