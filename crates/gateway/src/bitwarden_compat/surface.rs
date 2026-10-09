//! The Bitwarden server itself, compiled only with the `bitwarden-compat`
//! feature. See the parent module for the variables it reads.

use anyhow::Context as _;
use axum::Router;
use opensesame_bitwarden_server::hashing::HashRegistry;
use opensesame_bitwarden_server::kdf::KdfPolicy;
use opensesame_bitwarden_server::{BitwardenServer, ServerConfig, SignupPolicy};
use opensesame_storage::Db;
use zeroize::Zeroizing;

use super::enabled;

/// Where the surface is mounted on the Host.
pub const MOUNT: &str = "/bitwarden";

/// The server configuration the environment describes, or `None` when the
/// surface is off.
fn config_from(lookup: impl Fn(&str) -> Option<String>, resource: &str) -> Option<ServerConfig> {
    if !enabled(lookup("OPENSESAME_BITWARDEN_COMPAT").as_deref()) {
        return None;
    }
    let url = lookup("OPENSESAME_BITWARDEN_URL")
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| format!("{}{MOUNT}", resource.trim_end_matches('/')));
    let mut config = ServerConfig::new(&url);
    config.signups =
        SignupPolicy::parse(&lookup("OPENSESAME_BITWARDEN_SIGNUPS").unwrap_or_default());
    config.kdf = KdfPolicy {
        allow_pbkdf2: !enabled(lookup("OPENSESAME_BITWARDEN_REQUIRE_ARGON2ID").as_deref()),
        ..KdfPolicy::default()
    };
    let mebibytes = |key: &str| {
        lookup(key)
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .map(|mib| mib.saturating_mul(1024 * 1024))
    };
    if let Some(bytes) = mebibytes("OPENSESAME_BITWARDEN_MAX_FILE_MB") {
        config.max_file_bytes = usize::try_from(bytes).unwrap_or(usize::MAX);
    }
    if let Some(bytes) = mebibytes("OPENSESAME_BITWARDEN_STORAGE_MB") {
        config.storage_quota_bytes = i64::try_from(bytes).unwrap_or(i64::MAX);
    }
    config.web_vault = lookup("OPENSESAME_BITWARDEN_WEB_VAULT")
        .filter(|dir| !dir.trim().is_empty())
        .map(std::path::PathBuf::from);
    Some(config)
}

/// A web-vault directory the operator named must hold the app; one that
/// does not is a misconfiguration, not a reason to serve nothing quietly.
fn check_web_vault(dir: Option<&std::path::Path>) -> anyhow::Result<()> {
    if let Some(dir) = dir {
        anyhow::ensure!(
            dir.join("index.html").is_file(),
            "OPENSESAME_BITWARDEN_WEB_VAULT names {}, which holds no index.html",
            dir.display()
        );
    }
    Ok(())
}

/// The access-token signing key: 32 or more bytes, hex-encoded. Replicas
/// behind one URL share it, so a token minted on one verifies on another.
fn token_key(raw: Option<&str>) -> anyhow::Result<Option<Zeroizing<Vec<u8>>>> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    let key = Zeroizing::new(
        hex::decode(raw).context("OPENSESAME_BITWARDEN_TOKEN_KEY must be hex-encoded")?,
    );
    anyhow::ensure!(
        key.len() >= 32,
        "OPENSESAME_BITWARDEN_TOKEN_KEY must hold at least 32 bytes"
    );
    Ok(Some(key))
}

/// The mounted surface, or an empty router when it is off.
///
/// # Errors
///
/// Fails when the surface is on and its token key is malformed; nothing is
/// served in that case rather than falling back to a per-process key.
pub fn from_env(db: Db, resource: &str) -> anyhow::Result<Router> {
    let Some(config) = config_from(|key| std::env::var(key).ok(), resource) else {
        return Ok(Router::new());
    };
    let key = token_key(
        std::env::var("OPENSESAME_BITWARDEN_TOKEN_KEY")
            .ok()
            .map(Zeroizing::new)
            .as_deref()
            .map(String::as_str),
    )?;
    check_web_vault(config.web_vault.as_deref())?;
    tracing::info!(
        url = %config.public_url,
        web_vault = config.web_vault.is_some(),
        signups = ?config.signups,
        allow_pbkdf2 = config.kdf.allow_pbkdf2,
        shared_token_key = key.is_some(),
        "bitwarden-compat surface mounted"
    );
    let server = BitwardenServer::new(
        db,
        config,
        HashRegistry::default(),
        key.as_deref().map(Vec::as_slice),
    );
    Ok(server.mounted(MOUNT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(pairs: &[(&str, &str)]) -> Option<ServerConfig> {
        let env: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        config_from(|key| env.get(key).cloned(), "https://host.example/")
    }

    #[test]
    fn the_surface_is_off_unless_the_operator_turns_it_on() {
        assert!(config(&[]).is_none());
        assert!(config(&[("OPENSESAME_BITWARDEN_COMPAT", "off")]).is_none());
        let on = config(&[("OPENSESAME_BITWARDEN_COMPAT", "on")]).unwrap();
        assert_eq!(on.public_url, "https://host.example/bitwarden");
        assert_eq!(on.signups, SignupPolicy::Closed);
        assert!(on.kdf.allow_pbkdf2);
    }

    #[test]
    fn a_web_vault_directory_must_hold_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let on = config(&[
            ("OPENSESAME_BITWARDEN_COMPAT", "on"),
            (
                "OPENSESAME_BITWARDEN_WEB_VAULT",
                dir.path().to_str().unwrap(),
            ),
        ])
        .unwrap();
        assert_eq!(on.web_vault.as_deref(), Some(dir.path()));
        assert!(check_web_vault(on.web_vault.as_deref()).is_err());
        std::fs::write(dir.path().join("index.html"), "<html></html>").unwrap();
        assert!(check_web_vault(on.web_vault.as_deref()).is_ok());
        assert!(check_web_vault(None).is_ok());
    }

    #[test]
    fn a_token_key_is_hex_and_long_enough_or_absent() {
        assert!(token_key(None).unwrap().is_none());
        assert!(token_key(Some("  ")).unwrap().is_none());
        assert_eq!(
            token_key(Some(&"ab".repeat(32))).unwrap().unwrap().len(),
            32
        );
        assert!(token_key(Some(&"ab".repeat(31))).is_err());
        assert!(token_key(Some("not hex")).is_err());
    }

    #[test]
    fn signups_url_and_argon2id_are_configurable() {
        let custom = config(&[
            ("OPENSESAME_BITWARDEN_COMPAT", "true"),
            ("OPENSESAME_BITWARDEN_URL", "https://vault.example"),
            ("OPENSESAME_BITWARDEN_SIGNUPS", "example.com, @corp.example"),
            ("OPENSESAME_BITWARDEN_REQUIRE_ARGON2ID", "true"),
        ])
        .unwrap();
        assert_eq!(custom.public_url, "https://vault.example");
        assert!(custom.signups.allows("a@corp.example"));
        assert!(!custom.signups.allows("a@elsewhere.example"));
        assert!(!custom.kdf.allow_pbkdf2);
    }

    #[test]
    fn file_limits_are_set_in_mebibytes() {
        let custom = config(&[
            ("OPENSESAME_BITWARDEN_COMPAT", "on"),
            ("OPENSESAME_BITWARDEN_MAX_FILE_MB", "25"),
            ("OPENSESAME_BITWARDEN_STORAGE_MB", "2048"),
        ])
        .unwrap();
        assert_eq!(custom.max_file_bytes, 25 * 1024 * 1024);
        assert_eq!(custom.storage_quota_bytes, 2048 * 1024 * 1024);
        let defaults = config(&[("OPENSESAME_BITWARDEN_COMPAT", "on")]).unwrap();
        assert_eq!(defaults.max_file_bytes, 100 * 1024 * 1024);
    }
}
