//! The plugin's own refusal to run unless a person installed and switched it
//! on (ADR 0150 §7).
//!
//! The `opensesame` CLI already checks the settings file and the pin before it
//! spawns the plugin. This is the same check again, from inside, so that
//! running the binary directly — from a download folder, from a copied path,
//! after the settings were switched off, or as a file that changed since it
//! was installed — issues no surrogate and opens no listener. Two things must
//! hold:
//!
//! 1. The settings file says `surrogate-proxy` is **active**: installed,
//!    recorded on, and not forced off by `OPENSESAME_PLUGIN_SURROGATE_PROXY`.
//!    Its recorded binary still hashes to its pin.
//! 2. **This** executable hashes to that pin too. A second copy with other
//!    bytes is not the plugin that was installed, whatever its name.

use std::path::{Path, PathBuf};

use opensesame_plugin_settings::{sha256_file, PluginSettings, PluginState, SettingsError};

/// The catalog id this binary answers to.
pub const PLUGIN_ID: &str = "surrogate-proxy";

/// Why the plugin will not start. A class, never a path or a digest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum GateError {
    #[error("plugin_settings_unreadable")]
    Settings,
    #[error("plugin_not_active")]
    NotActive,
    #[error("plugin_pin_mismatch")]
    PinMismatch,
}

impl From<SettingsError> for GateError {
    fn from(error: SettingsError) -> Self {
        match error {
            SettingsError::NotInstalled(_) => Self::NotActive,
            SettingsError::PinMismatch { .. } => Self::PinMismatch,
            _ => Self::Settings,
        }
    }
}

/// Proof that [`admit`] passed: the only way to call
/// [`serve`](super::serve::serve). Carries the settings file it was checked
/// against, which also locates the plugin's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    settings_path: PathBuf,
    state: PluginState,
}

impl Admitted {
    #[must_use]
    pub fn settings_path(&self) -> &Path {
        &self.settings_path
    }

    /// The switch as it stood when the plugin was admitted: what arms a
    /// declared login substitution (`LoginRoad::choose`).
    #[must_use]
    pub fn state(&self) -> &PluginState {
        &self.state
    }
}

/// Admit this process, or say why not.
///
/// # Errors
///
/// `Settings` when the file is unreadable, `NotActive` when the plugin is not
/// installed, not switched on or forced off, `PinMismatch` when either the
/// recorded binary or `own_exe` no longer hashes to the install pin.
pub fn admit(
    settings_path: &Path,
    own_exe: &Path,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Admitted, GateError> {
    let settings = PluginSettings::load(settings_path)?;
    let state = settings.state(PLUGIN_ID, &env)?;
    if !state.active {
        return Err(GateError::NotActive);
    }
    settings.verified_binary(PLUGIN_ID, &env)?;
    let pin = settings
        .plugins
        .get(PLUGIN_ID)
        .map(|installed| installed.sha256.clone())
        .ok_or(GateError::NotActive)?;
    let own = sha256_file(own_exe).map_err(|_| GateError::PinMismatch)?;
    if own != pin {
        return Err(GateError::PinMismatch);
    }
    Ok(Admitted {
        settings_path: settings_path.to_path_buf(),
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        settings: std::path::PathBuf,
        bin: std::path::PathBuf,
    }

    fn fixture(enabled: bool) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("opensesame-surrogate-proxy");
        std::fs::write(&bin, b"installed bytes").unwrap();
        let settings = dir.path().join("plugins.json");
        let mut file = PluginSettings::default();
        let pin = sha256_file(&bin).unwrap();
        file.record_install(PLUGIN_ID, "1", &pin, bin.to_str().unwrap())
            .unwrap();
        file.set_enabled(PLUGIN_ID, enabled).unwrap();
        file.save(&settings).unwrap();
        Fixture {
            _dir: dir,
            settings,
            bin,
        }
    }

    #[test]
    fn the_installed_enabled_binary_is_admitted() {
        let f = fixture(true);
        let admitted = admit(&f.settings, &f.bin, no_env).unwrap();
        assert_eq!(admitted.settings_path(), f.settings.as_path());
    }

    #[test]
    fn run_directly_while_not_installed_it_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("x");
        std::fs::write(&bin, b"x").unwrap();
        let refused = admit(&dir.path().join("plugins.json"), &bin, no_env);
        assert_eq!(refused, Err(GateError::NotActive));
    }

    #[test]
    fn run_directly_while_switched_off_it_refuses() {
        let f = fixture(false);
        assert_eq!(
            admit(&f.settings, &f.bin, no_env),
            Err(GateError::NotActive)
        );
    }

    #[test]
    fn an_environment_force_off_wins_over_the_file() {
        let f = fixture(true);
        let off = |key: &str| (key == "OPENSESAME_PLUGIN_SURROGATE_PROXY").then(|| "off".into());
        assert_eq!(admit(&f.settings, &f.bin, off), Err(GateError::NotActive));
    }

    #[test]
    fn a_copy_with_other_bytes_is_not_the_installed_plugin() {
        let f = fixture(true);
        let impostor = f.bin.with_file_name("impostor");
        std::fs::write(&impostor, b"other bytes").unwrap();
        assert_eq!(
            admit(&f.settings, &impostor, no_env),
            Err(GateError::PinMismatch)
        );
    }

    #[test]
    fn a_binary_changed_after_install_refuses() {
        let f = fixture(true);
        std::fs::write(&f.bin, b"tampered").unwrap();
        assert_eq!(
            admit(&f.settings, &f.bin, no_env),
            Err(GateError::PinMismatch)
        );
    }

    #[test]
    fn an_unreadable_settings_file_refuses() {
        let f = fixture(true);
        std::fs::write(&f.settings, b"{not json").unwrap();
        assert_eq!(admit(&f.settings, &f.bin, no_env), Err(GateError::Settings));
    }
}
