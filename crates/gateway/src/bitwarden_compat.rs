//! The Bitwarden-compatible surface (ADR 0141), mounted at `/bitwarden` when
//! the operator turns it on. Off by default: nothing is routed, nothing is
//! read, and the tables stay empty.
//!
//! It is a password-manager bridge (ADR 0148), so it is also off at build
//! time: only a Host built with the `bitwarden-compat` feature can serve it.
//! A Host built without it that is asked to serve it refuses to start rather
//! than come up without the surface the operator configured.
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
//! | `OPENSESAME_BITWARDEN_TOKEN_KEY` | 32+ hex-encoded bytes that sign access tokens, shared by every replica; unset = a per-process key |
//! | `OPENSESAME_BITWARDEN_MAX_FILE_MB` | the largest attachment or Send file, in MiB; default 100 |
//! | `OPENSESAME_BITWARDEN_STORAGE_MB` | files one account may keep, in MiB; default 1024 |
//! | `OPENSESAME_BITWARDEN_WEB_VAULT` | a directory holding a build of Bitwarden's web vault to serve; unset serves none |

use axum::Router;
use opensesame_storage::Db;

#[cfg(feature = "bitwarden-compat")]
mod surface;

fn enabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("on" | "true" | "1" | "yes")
    )
}

/// The mounted surface, or an empty router when it is off.
///
/// # Errors
///
/// Fails when the surface is on and its token key is malformed, and when it
/// is on in a Host built without the `bitwarden-compat` feature.
pub fn from_env(db: Db, resource: &str) -> anyhow::Result<Router> {
    if !enabled(std::env::var("OPENSESAME_BITWARDEN_COMPAT").ok().as_deref()) {
        return Ok(Router::new());
    }
    mount(db, resource)
}

#[cfg(feature = "bitwarden-compat")]
fn mount(db: Db, resource: &str) -> anyhow::Result<Router> {
    surface::from_env(db, resource)
}

#[cfg(not(feature = "bitwarden-compat"))]
fn mount(_db: Db, _resource: &str) -> anyhow::Result<Router> {
    anyhow::bail!(
        "OPENSESAME_BITWARDEN_COMPAT is on, but this Host was built without the \
         Bitwarden bridge; rebuild with `--features bitwarden-compat` or unset it"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_on_and_its_synonyms_turn_the_surface_on() {
        for on in ["on", "ON", " true ", "1", "yes"] {
            assert!(enabled(Some(on)), "{on}");
        }
        for off in [None, Some(""), Some("off"), Some("false"), Some("0")] {
            assert!(!enabled(off), "{off:?}");
        }
    }

    #[cfg(not(feature = "bitwarden-compat"))]
    #[tokio::test]
    async fn a_host_without_the_bridge_refuses_to_serve_it() {
        let db = Db::connect_memory().await.unwrap();
        let refused = mount(db, "https://host.example").unwrap_err();
        assert!(refused.to_string().contains("--features bitwarden-compat"));
    }
}
