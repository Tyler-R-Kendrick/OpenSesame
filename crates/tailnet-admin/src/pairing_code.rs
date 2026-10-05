//! The printed tailnet pairing code (ADR 0168 §3) and the role it carries.
//!
//! `opensesame-tailnet:v1:` + base64url of
//! `{"url","code","origin","role","label"}`: where the daemon is, a one-time
//! secret, the one origin that may trade it, the role the bearer will hold,
//! and what the operator called it. `spec/conformance/tailnet-admin-protocol.json`
//! pins the wire form for Pages.

use base64::Engine as _;
use rand_core::{OsRng, RngCore as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest as _, Sha256};

/// What a tailnet pairing code starts with.
pub const CODE_PREFIX: &str = "opensesame-tailnet:v1:";
/// How long a code may wait to be traded.
pub const CODE_TTL_SECS: u64 = 300;
/// Longest label a code carries.
pub(crate) const MAX_LABEL_CHARS: usize = 80;

/// What a bearer may do (ADR 0168 §3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Status, devices, routes, auth keys and the audit trail.
    Read,
    /// Everything `read` may, and every change.
    Manage,
}

impl Role {
    /// Whether a bearer holding `self` may do what `needed` requires.
    #[must_use]
    pub fn allows(self, needed: Role) -> bool {
        matches!((self, needed), (Role::Manage, _) | (Role::Read, Role::Read))
    }

    /// `read` or `manage`, as the CLI takes it.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "read" => Some(Self::Read),
            "manage" => Some(Self::Manage),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Manage => "manage",
        }
    }
}

/// A label as a code carries it: printable, trimmed, at most 80 characters.
pub(crate) fn clean_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_LABEL_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The code `opensesame tailnet pair` prints.
#[must_use]
pub fn format_pairing_code(url: &str, code: &str, origin: &str, role: Role, label: &str) -> String {
    let body = json!({
        "url": url,
        "code": code,
        "origin": origin,
        "role": role.as_str(),
        "label": clean_label(label),
    });
    format!(
        "{CODE_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body.to_string())
    )
}

/// 32 random bytes, unpadded base64url: a code and a bearer alike.
pub(crate) fn secret() -> String {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

/// A short id an operator can name a pairing by.
pub(crate) fn pairing_id() -> String {
    let mut raw = [0u8; 6];
    OsRng.fill_bytes(&mut raw);
    format!("tp_{}", hex::encode(raw))
}

pub(crate) fn digest_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// Constant-time over equal-length digests.
pub(crate) fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_nest() {
        assert!(Role::Manage.allows(Role::Read));
        assert!(Role::Manage.allows(Role::Manage));
        assert!(Role::Read.allows(Role::Read));
        assert!(!Role::Read.allows(Role::Manage));
        assert_eq!(Role::parse("manage"), Some(Role::Manage));
        assert_eq!(Role::parse("admin"), None);
    }

    #[test]
    fn the_code_decodes_to_what_was_printed() {
        let code = format_pairing_code(
            "https://box.tail1.ts.net",
            "c0de",
            "https://example.github.io",
            Role::Manage,
            "ops\u{7}laptop",
        );
        let body = code.strip_prefix(CODE_PREFIX).unwrap();
        let json: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(body)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["role"], "manage");
        assert_eq!(json["label"], "opslaptop");
        assert_eq!(json["origin"], "https://example.github.io");
    }

    #[test]
    fn secrets_are_fresh_and_shaped() {
        let (a, b) = (secret(), secret());
        assert_ne!(a, b);
        assert!(opensesame_plugin_settings::is_secret_shaped(&a));
        assert!(same(&digest_hex(&a), &digest_hex(&a)));
        assert!(!same(&digest_hex(&a), &digest_hex(&b)));
        assert!(pairing_id().starts_with("tp_"));
    }
}
