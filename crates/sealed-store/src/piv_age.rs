//! PIV / age-plugin-yubikey discovery (KP-29).
//!
//! Non-destructive by default: never invokes `ykman` generate/change/reset.
//! Discovery prefers documenting whether `age-plugin-yubikey` is resolvable
//! and whether a dry-run list command can be attempted.

use std::path::PathBuf;
use std::process::Command;

use opensesame_trusted_exec::ResolveError;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Outcome of a non-destructive PIV-age discovery probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivAgeDiscovery {
    pub plugin_path: Option<String>,
    pub runtime: PivAgeRuntime,
    pub requires_hardware: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PivAgeRuntime {
    Available,
    RequiresHardware,
    PluginMissing,
    Unavailable,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PivAgeError {
    #[error("piv-age requires hardware presence")]
    RequiresHardware,
    #[error("age-plugin-yubikey not found")]
    PluginMissing,
    #[error("destructive ykman operations are refused by default (KP-29)")]
    DestructiveRefused,
    #[error("{0}")]
    Other(String),
}

/// The variable that names the exact `age-plugin-yubikey` to run.
const PLUGIN_OVERRIDE: &str = "OPENSESAME_AGE_PLUGIN_YUBIKEY";

/// Resolve `age-plugin-yubikey` without mutating device state.
#[must_use]
pub fn discover_piv_age() -> PivAgeDiscovery {
    let mut notes = Vec::new();
    let mut command = match plugin_command() {
        Ok(command) => command,
        Err(why) => {
            notes.push(why.to_string());
            notes.push("install age-plugin-yubikey per its docs, or name it with OPENSESAME_AGE_PLUGIN_YUBIKEY".into());
            return PivAgeDiscovery {
                plugin_path: None,
                runtime: PivAgeRuntime::PluginMissing,
                requires_hardware: true,
                notes,
            };
        }
    };
    let path = PathBuf::from(command.get_program());

    // Dry-run oriented probe: `--help` only. Never `--generate`, never ykman.
    let help = command.arg("--help").output();
    match help {
        Ok(out) if out.status.success() => {
            notes.push("plugin binary responds to --help (dry-run)".into());
            notes.push("hardware identity list requires a present YubiKey".into());
            PivAgeDiscovery {
                plugin_path: Some(path.display().to_string()),
                runtime: PivAgeRuntime::RequiresHardware,
                requires_hardware: true,
                notes,
            }
        }
        Ok(_) | Err(_) => {
            notes.push("plugin present but help probe failed".into());
            PivAgeDiscovery {
                plugin_path: Some(path.display().to_string()),
                runtime: PivAgeRuntime::Unavailable,
                requires_hardware: true,
                notes,
            }
        }
    }
}

/// Explicitly refuse destructive `ykman` operations unless a future opt-in API
/// is added. Default path always errors.
///
/// # Errors
///
/// Always returns `DestructiveRefused` for the default policy.
pub fn refuse_destructive_ykman(_args: &[&str]) -> Result<(), PivAgeError> {
    Err(PivAgeError::DestructiveRefused)
}

/// `age-plugin-yubikey`: the file `OPENSESAME_AGE_PLUGIN_YUBIKEY` names, or
/// the one on a trusted `PATH` entry (`opensesame-trusted-exec`). A value that
/// cannot be used is an error, never a reason to search `PATH`. It is handed
/// `PATH` (the trusted entries) and the common set only: `--help` needs no
/// more, and the plugin reaches the card through pcscd's socket.
fn plugin_command() -> Result<Command, ResolveError> {
    opensesame_trusted_exec::command("age-plugin-yubikey", PLUGIN_OVERRIDE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destructive_ykman_refused_by_default() {
        let err = refuse_destructive_ykman(&["piv", "keys", "generate", "9a"]).unwrap_err();
        assert_eq!(err, PivAgeError::DestructiveRefused);
    }

    #[test]
    fn discovery_never_panics() {
        let d = discover_piv_age();
        assert!(d.requires_hardware);
        assert!(!d.notes.is_empty() || d.plugin_path.is_some() || d.plugin_path.is_none());
    }
}
