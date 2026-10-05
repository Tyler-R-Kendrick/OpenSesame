//! Which tailnet this daemon manages, and with what credential.
//!
//! `tailnet-admin.json` says which tailnet and what kind of credential;
//! `tailnet-admin.secret` holds the credential itself. Both are `0600` in a
//! `0700` directory owned by the daemon's user, and `disconnect` deletes
//! both. The secret is read into a [`SecretString`] for the one call that
//! needs it and is never returned by anything in this crate.

use std::path::{Path, PathBuf};

use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Serialize};

use crate::audit::AuditLog;
use crate::pairing::RolePairings;
use crate::paths::{ensure_private_dir, read_optional, write_private};
use crate::AdminError;

const CONFIG_FILE: &str = "tailnet-admin.json";
const SECRET_FILE: &str = "tailnet-admin.secret";
const FILE_VERSION: u32 = 1;

/// The kind of credential, as `status` reports it (never the value).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    /// An OAuth client: scoped, traded for hour-long access tokens.
    Oauth,
    /// An API access token: its owner's full rights, expires within 90 days.
    ApiKey,
}

/// What `connect` records beside the secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credential {
    pub kind: CredentialKind,
    /// The OAuth client's id; empty for an API access token.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_id: String,
}

/// The connected tailnet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TailnetConfig {
    v: u32,
    /// The tailnet id, or `-` for the credential's own tailnet.
    pub tailnet: String,
    pub credential: Credential,
    pub connected_at: u64,
}

/// The directory the daemon and `opensesame tailnet` share.
#[derive(Clone, Debug)]
pub struct AdminStore {
    dir: PathBuf,
}

fn valid_tailnet(tailnet: &str) -> bool {
    tailnet == "-"
        || ((1..=128).contains(&tailnet.len())
            && tailnet
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._@-".contains(&b)))
}

fn valid_client_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `tskey-client-…` for an OAuth client, `tskey-api-…` for an access token.
fn valid_secret(kind: CredentialKind, secret: &str) -> bool {
    let prefix = match kind {
        CredentialKind::Oauth => "tskey-client-",
        CredentialKind::ApiKey => "tskey-api-",
    };
    secret.strip_prefix(prefix).is_some_and(|rest| {
        (8..=200).contains(&rest.len())
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

impl AdminStore {
    #[must_use]
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    #[must_use]
    pub fn pairings(&self) -> RolePairings {
        RolePairings::at(&self.dir)
    }

    #[must_use]
    pub fn audit(&self) -> AuditLog {
        AuditLog::at(&self.dir)
    }

    /// The connected tailnet, or `None` before `connect`.
    ///
    /// # Errors
    ///
    /// `Unreadable` for a file this build did not write, or a read error.
    pub fn config(&self) -> Result<Option<TailnetConfig>, AdminError> {
        let Some(bytes) = read_optional(&self.dir.join(CONFIG_FILE))? else {
            return Ok(None);
        };
        let config: TailnetConfig = serde_json::from_slice(&bytes)
            .map_err(|error| AdminError::Unreadable(error.to_string()))?;
        if config.v != FILE_VERSION || !valid_tailnet(&config.tailnet) {
            return Err(AdminError::Unreadable("tailnet-admin.json".into()));
        }
        Ok(Some(config))
    }

    /// Record the tailnet and its credential, replacing any before.
    ///
    /// # Errors
    ///
    /// `Invalid` for a malformed tailnet, client id or secret; a write error.
    pub fn connect(
        &self,
        tailnet: &str,
        credential: Credential,
        secret: &SecretString,
        now: u64,
    ) -> Result<TailnetConfig, AdminError> {
        let tailnet = tailnet.trim();
        if !valid_tailnet(tailnet) {
            return Err(AdminError::Invalid("invalid_tailnet"));
        }
        let oauth = credential.kind == CredentialKind::Oauth;
        if oauth == credential.client_id.is_empty()
            || (oauth && !valid_client_id(&credential.client_id))
        {
            return Err(AdminError::Invalid("invalid_client_id"));
        }
        if !valid_secret(credential.kind, secret.expose_secret().trim()) {
            return Err(AdminError::Invalid("invalid_credential"));
        }
        ensure_private_dir(&self.dir)?;
        write_private(
            &self.dir.join(SECRET_FILE),
            secret.expose_secret().trim().as_bytes(),
        )?;
        let config = TailnetConfig {
            v: FILE_VERSION,
            tailnet: tailnet.to_string(),
            credential,
            connected_at: now,
        };
        let bytes = serde_json::to_vec_pretty(&config)
            .map_err(|error| AdminError::Unreadable(error.to_string()))?;
        write_private(&self.dir.join(CONFIG_FILE), &bytes)?;
        Ok(config)
    }

    /// Forget the tailnet and delete the credential. True when one was set.
    ///
    /// # Errors
    ///
    /// A file error other than "already gone".
    pub fn disconnect(&self) -> Result<bool, AdminError> {
        let mut removed = false;
        for name in [SECRET_FILE, CONFIG_FILE] {
            match std::fs::remove_file(self.dir.join(name)) {
                Ok(()) => removed = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(removed)
    }

    /// The credential, for the one call that needs it.
    ///
    /// # Errors
    ///
    /// `NotConnected` when there is none, `Unreadable` when it is malformed.
    pub(crate) fn secret(&self, kind: CredentialKind) -> Result<SecretString, AdminError> {
        let bytes = read_optional(&self.dir.join(SECRET_FILE))?.ok_or(AdminError::NotConnected)?;
        let text = zeroize::Zeroizing::new(
            String::from_utf8(bytes).map_err(|_| AdminError::Unreadable("secret".into()))?,
        );
        let trimmed = text.trim();
        if !valid_secret(kind, trimmed) {
            return Err(AdminError::Unreadable("secret".into()));
        }
        Ok(SecretString::from(trimmed.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oauth() -> Credential {
        Credential {
            kind: CredentialKind::Oauth,
            client_id: "kAbC123CNTRL".into(),
        }
    }

    #[test]
    fn connect_records_the_tailnet_and_keeps_the_secret_apart() {
        let tmp = tempfile::tempdir().unwrap();
        let store = AdminStore::at(tmp.path());
        assert_eq!(store.config().unwrap(), None);
        let secret = SecretString::from("tskey-client-kAbC123CNTRL-0123456789abcdef".to_string());
        let config = store.connect("example.com", oauth(), &secret, 7).unwrap();
        assert_eq!(store.config().unwrap(), Some(config));
        let json = std::fs::read_to_string(tmp.path().join(CONFIG_FILE)).unwrap();
        assert!(
            !json.contains("tskey-"),
            "the config file never holds the secret"
        );
        let read = store.secret(CredentialKind::Oauth).unwrap();
        assert_eq!(read.expose_secret(), secret.expose_secret());
        assert!(store.disconnect().unwrap());
        assert_eq!(store.config().unwrap(), None);
        assert!(matches!(
            store.secret(CredentialKind::Oauth),
            Err(AdminError::NotConnected)
        ));
        assert!(!store.disconnect().unwrap());
    }

    #[test]
    fn connect_refuses_what_tailscale_never_issues() {
        let tmp = tempfile::tempdir().unwrap();
        let store = AdminStore::at(tmp.path());
        let good = SecretString::from("tskey-client-abc-0123456789".to_string());
        let api = Credential {
            kind: CredentialKind::ApiKey,
            client_id: String::new(),
        };
        let cases: [(&str, Credential, &str, &str); 5] = [
            (
                "../etc",
                oauth(),
                "tskey-client-abc-0123456789",
                "invalid_tailnet",
            ),
            (
                "-",
                api.clone(),
                "tskey-client-abc-0123456789",
                "invalid_credential",
            ),
            (
                "-",
                oauth(),
                "tskey-api-abc-0123456789",
                "invalid_credential",
            ),
            (
                "-",
                Credential {
                    kind: CredentialKind::Oauth,
                    client_id: String::new(),
                },
                "tskey-client-abc-0123456789",
                "invalid_client_id",
            ),
            (
                "-",
                Credential {
                    kind: CredentialKind::ApiKey,
                    client_id: "x".into(),
                },
                "tskey-api-abc-0123456789",
                "invalid_client_id",
            ),
        ];
        for (tailnet, credential, secret, code) in cases {
            let error = store
                .connect(
                    tailnet,
                    credential,
                    &SecretString::from(secret.to_string()),
                    1,
                )
                .unwrap_err();
            assert_eq!(error.code(), code);
        }
        assert!(store.connect("-", oauth(), &good, 1).is_ok());
        assert!(store
            .connect(
                "user@example.com",
                api,
                &SecretString::from("tskey-api-k1-abcdefgh".to_string()),
                1
            )
            .is_ok());
    }
}
