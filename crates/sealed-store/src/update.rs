//! pass-update style secret rotation helpers.
//!
//! Rotation is agent-hostile: helpers return updated [`Entry`] values for the
//! human CLI / store writer to seal. Changelog metadata never includes secret
//! values — only path names and opaque version ids.

use regex::Regex;

use crate::entry::Entry;
use crate::generate::generate_password;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateMode {
    /// Replace first line only; keep trailer/OTP.
    FirstLine,
    /// Replace entire body (secret + trailer); OTP cleared unless re-supplied.
    Multiline,
}

#[derive(Debug, Clone)]
pub struct UpdateOptions {
    pub mode: UpdateMode,
    pub length: usize,
    pub auto_length: bool,
    pub symbols: bool,
    pub include: Option<Regex>,
    pub exclude: Option<Regex>,
}

impl Default for UpdateOptions {
    fn default() -> Self {
        Self {
            mode: UpdateMode::FirstLine,
            length: 32,
            auto_length: false,
            symbols: true,
            include: None,
            exclude: None,
        }
    }
}

/// Frozen changelog event name for sealed-store value rotation (metadata only).
pub const CHANGELOG_SECRET_VALUE_CHANGED: &str = "secret.value.changed";

/// Metadata emitted when a sealed-store path is rotated. Never carries plaintext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotationChangelogEvent {
    pub event_type: &'static str,
    pub store_path: String,
    pub project_id: Option<String>,
    /// Opaque generation id (not a secret digest).
    pub version_id: String,
    pub key_names: Vec<String>,
}

impl RotationChangelogEvent {
    pub fn for_path(store_path: impl Into<String>, project_id: Option<String>) -> Self {
        let store_path = store_path.into();
        let version_id = format!(
            "ssrot_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        Self {
            event_type: CHANGELOG_SECRET_VALUE_CHANGED,
            key_names: vec![store_path.clone()],
            store_path,
            project_id,
            version_id,
        }
    }

    /// JSON-friendly metadata — rejects secret-shaped keys by construction.
    pub fn metadata_json(&self) -> serde_json::Value {
        serde_json::json!({
            "event_type": self.event_type,
            "store_path": self.store_path,
            "project_id": self.project_id,
            "version_id": self.version_id,
            "key_names": self.key_names,
        })
    }
}

/// Result of rotating a sealed entry. The new entry is for local sealing only;
/// agents must never receive [`Entry::secret`].
#[derive(Debug, Clone)]
pub struct SecretRotation {
    pub entry: Entry,
    pub changelog: RotationChangelogEvent,
}

/// Returns None when include/exclude say to skip this entry.
pub fn apply_secret_update(
    entry: &Entry,
    new_secret: Option<String>,
    opts: &UpdateOptions,
) -> Option<Entry> {
    if let Some(re) = &opts.exclude {
        if re.is_match(&entry.secret) {
            return None;
        }
    }
    if let Some(re) = &opts.include {
        if !re.is_match(&entry.secret) {
            return None;
        }
    }

    let length = if opts.auto_length {
        entry.secret.chars().count().max(1)
    } else {
        opts.length.max(1)
    };
    let secret = new_secret.unwrap_or_else(|| generate_password(length, opts.symbols));

    match opts.mode {
        UpdateMode::FirstLine => Some(Entry {
            secret,
            trailer: entry.trailer.clone(),
            otp: entry.otp.clone(),
        }),
        UpdateMode::Multiline => Some(Entry {
            secret,
            trailer: String::new(),
            otp: None,
        }),
    }
}

/// Rotate the first-line secret for a logical store path and produce changelog
/// metadata (no secret values). Prefer this over calling [`apply_secret_update`]
/// when emitting Host/bus changelog hooks.
pub fn rotate_secret_entry(
    store_path: &str,
    entry: &Entry,
    new_secret: Option<String>,
    opts: &UpdateOptions,
    project_id: Option<String>,
) -> Option<SecretRotation> {
    let next = apply_secret_update(entry, new_secret, opts)?;
    Some(SecretRotation {
        entry: next,
        changelog: RotationChangelogEvent::for_path(store_path, project_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::otp::parse_otpauth;

    #[test]
    fn first_line_preserves_trailer_and_otp() {
        let otp = parse_otpauth(
            "otpauth://totp/Demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        )
        .unwrap();
        let entry = Entry {
            secret: "oldpass".into(),
            trailer: "login: a\n".into(),
            otp: Some(otp.clone()),
        };
        let next = apply_secret_update(&entry, Some("newpass".into()), &UpdateOptions::default())
            .unwrap();
        assert_eq!(next.secret, "newpass");
        assert!(next.trailer.contains("login: a") || next.render().contains("login: a"));
        assert!(next.otp.is_some());
    }

    #[test]
    fn exclude_regex_skips() {
        let entry = Entry {
            secret: "1234".into(),
            trailer: String::new(),
            otp: None,
        };
        let opts = UpdateOptions {
            exclude: Some(Regex::new(r"^[0-9]+$").unwrap()),
            ..Default::default()
        };
        assert!(apply_secret_update(&entry, Some("x".into()), &opts).is_none());
    }

    #[test]
    fn auto_length_matches_previous() {
        let entry = Entry {
            secret: "abcdefghij".into(),
            trailer: String::new(),
            otp: None,
        };
        let opts = UpdateOptions {
            auto_length: true,
            symbols: false,
            ..Default::default()
        };
        let next = apply_secret_update(&entry, None, &opts).unwrap();
        assert_eq!(next.secret.len(), 10);
    }

    #[test]
    fn rotate_emits_metadata_without_secret() {
        let entry = Entry {
            secret: "old-secret-value".into(),
            trailer: "note: keep\n".into(),
            otp: None,
        };
        let rotated = rotate_secret_entry(
            "Dev/api-token",
            &entry,
            Some("brand-new".into()),
            &UpdateOptions::default(),
            Some("project:personal".into()),
        )
        .unwrap();
        assert_eq!(rotated.entry.secret, "brand-new");
        assert!(rotated.entry.trailer.contains("note: keep"));
        assert_eq!(rotated.changelog.event_type, CHANGELOG_SECRET_VALUE_CHANGED);
        let meta = rotated.changelog.metadata_json().to_string();
        assert!(meta.contains("Dev/api-token"));
        assert!(!meta.contains("old-secret-value"));
        assert!(!meta.contains("brand-new"));
        assert!(!meta.contains("\"password\""));
        assert!(!meta.contains("\"value\""));
    }

    #[test]
    fn rotate_respects_exclude() {
        let entry = Entry {
            secret: "1234".into(),
            trailer: String::new(),
            otp: None,
        };
        let opts = UpdateOptions {
            exclude: Some(Regex::new(r"^[0-9]+$").unwrap()),
            ..Default::default()
        };
        assert!(rotate_secret_entry("x", &entry, Some("y".into()), &opts, None).is_none());
    }
}
