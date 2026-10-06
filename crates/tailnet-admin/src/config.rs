//! Which tailnet this daemon manages, and with what credential.
//!
//! `tailnet-admin.json` says which tailnet and what kind of credential;
//! `tailnet-admin.secret` holds a scoped wrapped-DEK envelope. A separate
//! `tailnet-admin.key` is the local bootstrap root. Files are `0600` in a
//! `0700` directory owned by the daemon's user, and `disconnect` deletes
//! both. The secret is read into a [`SecretString`] for the one call that
//! needs it and is never returned by anything in this crate.

use std::path::{Path, PathBuf};

use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::audit::AuditLog;
use crate::pairing::RolePairings;
use crate::paths::{ensure_private_dir, read_optional, write_private, FileLock};
use crate::AdminError;
use opensesame_sealed_log::LogKey;

const CONFIG_FILE: &str = "tailnet-admin.json";
const SECRET_FILE: &str = "tailnet-admin.secret";
const KEY_FILE: &str = "tailnet-admin.key";
const FILE_VERSION: u32 = 2;
const PURPOSE: &str = "tailnet-admin.credential";

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

fn valid_credential(credential: &Credential) -> bool {
    match credential.kind {
        CredentialKind::Oauth => valid_client_id(&credential.client_id),
        CredentialKind::ApiKey => credential.client_id.is_empty(),
    }
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
        if !matches!(config.v, 1 | FILE_VERSION)
            || !valid_tailnet(&config.tailnet)
            || !valid_credential(&config.credential)
        {
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
        if !valid_credential(&credential) {
            return Err(AdminError::Invalid("invalid_client_id"));
        }
        if !valid_secret(credential.kind, secret.expose_secret().trim()) {
            return Err(AdminError::Invalid("invalid_credential"));
        }
        ensure_private_dir(&self.dir)?;
        let _lock = FileLock::acquire(&self.dir.join(CONFIG_FILE))?;
        let config = TailnetConfig {
            v: FILE_VERSION,
            tailnet: tailnet.to_string(),
            credential,
            connected_at: now,
        };
        let key = self.connection_key()?;
        let sealed = key.seal_value(
            &self.namespace(&config)?,
            PURPOSE,
            secret.expose_secret().trim(),
        );
        write_private(&self.dir.join(SECRET_FILE), sealed.as_bytes())?;
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
        if !self.dir.is_dir() {
            return Ok(false);
        }
        let _lock = FileLock::acquire(&self.dir.join(CONFIG_FILE))?;
        let mut removed = false;
        for name in [SECRET_FILE, CONFIG_FILE, KEY_FILE] {
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
    #[cfg(test)]
    pub(crate) fn secret(&self, expected: &TailnetConfig) -> Result<SecretString, AdminError> {
        self.credential_snapshot(expected).map(|(secret, _)| secret)
    }

    pub(crate) fn credential_snapshot(
        &self,
        expected: &TailnetConfig,
    ) -> Result<(SecretString, [u8; 32]), AdminError> {
        self.config()?.ok_or(AdminError::NotConnected)?;
        let _lock = FileLock::acquire(&self.dir.join(CONFIG_FILE))?;
        let config = self.config()?.ok_or(AdminError::NotConnected)?;
        if config.tailnet != expected.tailnet
            || config.credential != expected.credential
            || config.connected_at != expected.connected_at
        {
            return Err(AdminError::Unreadable("credential context".into()));
        }
        let kind = config.credential.kind;
        let bytes = read_optional(&self.dir.join(SECRET_FILE))?.ok_or(AdminError::NotConnected)?;
        if bytes.len() > 4096 {
            return Err(AdminError::Unreadable("secret".into()));
        }
        let text = zeroize::Zeroizing::new(
            String::from_utf8(bytes).map_err(|_| AdminError::Unreadable("secret".into()))?,
        );
        let trimmed = text.trim();
        let key_path = self.dir.join(KEY_FILE);
        let namespace = self.namespace(&config)?;
        let plain = if trimmed.starts_with("osev2.") {
            let key = LogKey::load(&key_path)?;
            zeroize::Zeroizing::new(key.open_value(&namespace, PURPOSE, trimmed)?)
        } else {
            if config.v != 1 || !valid_secret(kind, trimmed) {
                return Err(AdminError::Unreadable("secret".into()));
            }
            self.trusted_legacy()?;
            let key = LogKey::load_or_create(&key_path)?;
            let sealed = key.seal_value(&namespace, PURPOSE, trimmed);
            write_private(&self.dir.join(SECRET_FILE), sealed.as_bytes())?;
            zeroize::Zeroizing::new(trimmed.to_owned())
        };
        if !valid_secret(kind, plain.as_str()) {
            return Err(AdminError::Unreadable("secret".into()));
        }
        if config.v == 1 {
            let current = TailnetConfig {
                v: FILE_VERSION,
                ..config
            };
            let bytes = serde_json::to_vec_pretty(&current)
                .map_err(|_| AdminError::Unreadable("config".into()))?;
            write_private(&self.dir.join(CONFIG_FILE), &bytes)?;
        }
        let mut cache = Sha256::new();
        cache.update((namespace.len() as u64).to_be_bytes());
        cache.update(namespace.as_bytes());
        cache.update(plain.as_bytes());
        Ok((
            SecretString::from(plain.to_string()),
            cache.finalize().into(),
        ))
    }

    // A damaged marker does not authorize replacing a missing root.
    fn connection_key(&self) -> Result<LogKey, AdminError> {
        let config = self.config()?;
        let stored = read_optional(&self.dir.join(SECRET_FILE))?;
        let key_path = self.dir.join(KEY_FILE);
        let (config, bytes) = match (config, stored) {
            (None, None) => return Ok(LogKey::load_or_create(&key_path)?),
            (Some(config), Some(bytes)) => (config, bytes),
            _ => return Err(AdminError::Unreadable("incomplete credential state".into())),
        };
        if bytes.len() > 4096 {
            return Err(AdminError::Unreadable("secret".into()));
        }
        let text = zeroize::Zeroizing::new(
            String::from_utf8(bytes).map_err(|_| AdminError::Unreadable("secret".into()))?,
        );
        if text.trim().starts_with("osev2.") {
            let key = LogKey::load(&key_path)?;
            let plain = zeroize::Zeroizing::new(key.open_value(
                &self.namespace(&config)?,
                PURPOSE,
                text.trim(),
            )?);
            if !valid_secret(config.credential.kind, &plain) {
                return Err(AdminError::Unreadable("secret".into()));
            }
            return Ok(key);
        }
        if config.v != 1 || !valid_secret(config.credential.kind, text.trim()) {
            return Err(AdminError::Unreadable("secret".into()));
        }
        self.trusted_legacy()?;
        Ok(LogKey::load_or_create(&key_path)?)
    }

    fn namespace(&self, config: &TailnetConfig) -> Result<String, AdminError> {
        let dir = std::fs::canonicalize(&self.dir)?;
        // Canonical trusted local directory plus length-safe typed configuration.
        let context = (
            "tailnet-admin.v2",
            hex::encode(dir.as_os_str().as_encoded_bytes()),
            &config.tailnet,
            config.credential.kind,
            &config.credential.client_id,
        );
        serde_json::to_string(&context).map_err(|_| AdminError::Unreadable("context".into()))
    }

    // Legacy provenance is the known private local config, never ciphertext metadata.
    #[cfg(unix)]
    fn trusted_legacy(&self) -> Result<(), AdminError> {
        use std::os::unix::fs::PermissionsExt;
        for path in [
            self.dir.clone(),
            self.dir.join(CONFIG_FILE),
            self.dir.join(SECRET_FILE),
        ] {
            let metadata = std::fs::symlink_metadata(path)?;
            if metadata.permissions().mode() & 0o077 != 0 || metadata.file_type().is_symlink() {
                return Err(AdminError::Unreadable(
                    "legacy credential permissions".into(),
                ));
            }
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn trusted_legacy(&self) -> Result<(), AdminError> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "credential_envelope_tests.rs"]
mod envelope_tests;
