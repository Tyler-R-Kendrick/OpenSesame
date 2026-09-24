//! The Bitwarden-compatible surface (ADR 0141), mounted at `/bitwarden` when
//! the operator turns it on. Off by default: nothing is routed, nothing is
//! read, and the tables stay empty.
//!
//! Configuration is read from the environment, as `callback_ingress` is, so
//! the Host's argument struct does not grow a field per optional surface:
//!
//! | Variable | Meaning |
//! |---|---|
//! | `OPENSESAME_BITWARDEN_COMPAT` | `on` mounts the surface |
//! | `OPENSESAME_BITWARDEN_URL` | the URL clients are given; default `<resource>/bitwarden` |
//! | `OPENSESAME_BITWARDEN_SIGNUPS` | `closed` (default), `open`, or a comma-separated domain list |
//! | `OPENSESAME_BITWARDEN_REQUIRE_ARGON2ID` | `true` refuses PBKDF2 for new accounts and KDF changes |

use axum::Router;
use opensesame_bitwarden_server::hashing::HashRegistry;
use opensesame_bitwarden_server::kdf::KdfPolicy;
use opensesame_bitwarden_server::{BitwardenServer, ServerConfig, SignupPolicy};
use opensesame_storage::Db;

/// Where the surface is mounted on the Host.
pub const MOUNT: &str = "/bitwarden";

fn enabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("on" | "true" | "1" | "yes")
    )
}

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
    Some(config)
}

/// The mounted surface, or an empty router when it is off.
pub fn from_env(db: Db, resource: &str) -> Router {
    let Some(config) = config_from(|key| std::env::var(key).ok(), resource) else {
        return Router::new();
    };
    tracing::info!(
        url = %config.public_url,
        signups = ?config.signups,
        allow_pbkdf2 = config.kdf.allow_pbkdf2,
        "bitwarden-compat surface mounted"
    );
    let server = BitwardenServer::new(db, config, HashRegistry::default(), None);
    Router::new().nest(MOUNT, server.router())
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
}
