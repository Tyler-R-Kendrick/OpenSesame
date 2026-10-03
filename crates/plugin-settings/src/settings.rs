//! The plugin settings file: which plugins are installed, where, pinned to
//! which sha256, and whether each is on.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalog;

/// Overrides the settings file's location (tests, and operators who keep
/// configuration elsewhere).
pub const SETTINGS_PATH_ENV: &str = "OPENSESAME_PLUGINS_FILE";

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("unknown plugin {0}")]
    UnknownPlugin(String),
    #[error("plugin {0} is not installed")]
    NotInstalled(String),
    #[error("plugin {id} does not match its install pin")]
    PinMismatch { id: String },
    #[error("a sha256 pin is 64 lowercase hex characters")]
    MalformedPin,
    #[error("plugin settings are unreadable: {0}")]
    Unreadable(String),
    #[error("plugin settings schema {0} is not supported")]
    UnsupportedSchema(u8),
    #[error("no config directory for plugin settings")]
    NoConfigDir,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// One installed plugin, as the settings file records it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledPlugin {
    pub version: String,
    /// Lowercase hex sha256 of the installed artifact.
    pub sha256: String,
    /// The installed binary, for a native plugin. A browser extension records
    /// its store or package id here instead of a path.
    pub location: String,
    pub enabled: bool,
}

/// What a caller needs to know about one plugin right now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "a wire view of four independent facts Settings shows side by side"
)]
pub struct PluginState {
    pub id: String,
    pub capability: String,
    pub installed: bool,
    pub version: Option<String>,
    /// Recorded on in the file.
    pub enabled: bool,
    /// Forced off by `OPENSESAME_PLUGIN_<ID>=off`.
    pub forced_off: bool,
    /// Enabled and not forced off: the only state in which it may run.
    pub active: bool,
}

/// The settings file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginSettings {
    pub schema_version: u8,
    #[serde(default)]
    pub plugins: BTreeMap<String, InstalledPlugin>,
}

/// `<config dir>/plugins.json`, or [`SETTINGS_PATH_ENV`] when set.
///
/// # Errors
///
/// `NoConfigDir` when the platform has no home or config directory.
pub fn default_settings_path() -> Result<PathBuf, SettingsError> {
    if let Some(path) = std::env::var_os(SETTINGS_PATH_ENV).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let dirs = directories::ProjectDirs::from("dev", "OpenSesame", "opensesame")
        .ok_or(SettingsError::NoConfigDir)?;
    Ok(dirs.config_dir().join(catalog::settings_file_name()))
}

impl PluginSettings {
    /// Read the file; a missing file is an empty one (nothing installed).
    ///
    /// # Errors
    ///
    /// `Unreadable` for malformed JSON, `UnsupportedSchema` for a newer
    /// schema, `Io` otherwise.
    pub fn load(path: &Path) -> Result<Self, SettingsError> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    schema_version: catalog::schema_version(),
                    plugins: BTreeMap::new(),
                })
            }
            Err(error) => return Err(error.into()),
        };
        let settings: Self = serde_json::from_slice(&bytes)
            .map_err(|error| SettingsError::Unreadable(error.to_string()))?;
        if settings.schema_version != catalog::schema_version() {
            return Err(SettingsError::UnsupportedSchema(settings.schema_version));
        }
        Ok(settings)
    }

    /// Write atomically (temp file + rename), 0600 on Unix.
    ///
    /// # Errors
    ///
    /// `Io` when the directory or file cannot be written.
    pub fn save(&self, path: &Path) -> Result<(), SettingsError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| SettingsError::Unreadable(error.to_string()))?;
        write_private(&tmp, &bytes)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Record an install. The plugin must be in the catalog; it is recorded
    /// **off** whatever it was before — installing never switches anything on.
    ///
    /// # Errors
    ///
    /// `UnknownPlugin`, or `MalformedPin` for a pin that is not 64 hex chars.
    pub fn record_install(
        &mut self,
        id: &str,
        version: &str,
        sha256: &str,
        location: &str,
    ) -> Result<(), SettingsError> {
        catalog::find(id).ok_or_else(|| SettingsError::UnknownPlugin(id.to_string()))?;
        if sha256.len() != 64
            || !sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(SettingsError::MalformedPin);
        }
        self.schema_version = catalog::schema_version();
        self.plugins.insert(
            id.to_string(),
            InstalledPlugin {
                version: version.to_string(),
                sha256: sha256.to_string(),
                location: location.to_string(),
                enabled: false,
            },
        );
        Ok(())
    }

    /// Remove an install record. Returns whether one existed.
    pub fn remove(&mut self, id: &str) -> bool {
        self.plugins.remove(id).is_some()
    }

    /// Switch an installed plugin on or off.
    ///
    /// # Errors
    ///
    /// `UnknownPlugin` or `NotInstalled`.
    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), SettingsError> {
        catalog::find(id).ok_or_else(|| SettingsError::UnknownPlugin(id.to_string()))?;
        let entry = self
            .plugins
            .get_mut(id)
            .ok_or_else(|| SettingsError::NotInstalled(id.to_string()))?;
        entry.enabled = enabled;
        Ok(())
    }

    /// The state of `id`, reading the override from `env` (pass
    /// `|k| std::env::var(k).ok()` in production).
    ///
    /// # Errors
    ///
    /// `UnknownPlugin` for an id the catalog does not name.
    pub fn state(
        &self,
        id: &str,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<PluginState, SettingsError> {
        let row = catalog::find(id).ok_or_else(|| SettingsError::UnknownPlugin(id.to_string()))?;
        let installed = self.plugins.get(id);
        let enabled = installed.is_some_and(|p| p.enabled);
        let forced_off = env(&override_var(id)).is_some_and(|v| is_off(&v));
        Ok(PluginState {
            id: id.to_string(),
            capability: row.capability,
            installed: installed.is_some(),
            version: installed.map(|p| p.version.clone()),
            enabled,
            forced_off,
            active: enabled && !forced_off,
        })
    }

    /// Every catalog plugin's state, in catalog order.
    #[must_use]
    pub fn states(&self, env: impl Fn(&str) -> Option<String>) -> Vec<PluginState> {
        catalog::catalog()
            .iter()
            .filter_map(|row| self.state(&row.id, &env).ok())
            .collect()
    }

    /// The installed binary of an **active** native plugin, re-verified
    /// against its pin. This is the only way a caller gets a path to run.
    ///
    /// # Errors
    ///
    /// `NotInstalled` when it is not installed or not active, `PinMismatch`
    /// when the file changed since install, `Io` when it cannot be read.
    pub fn verified_binary(
        &self,
        id: &str,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<PathBuf, SettingsError> {
        let state = self.state(id, env)?;
        let entry = self.plugins.get(id).filter(|_| state.active);
        let entry = entry.ok_or_else(|| SettingsError::NotInstalled(id.to_string()))?;
        let path = PathBuf::from(&entry.location);
        if sha256_file(&path)? != entry.sha256 {
            return Err(SettingsError::PinMismatch { id: id.to_string() });
        }
        Ok(path)
    }
}

/// `OPENSESAME_PLUGIN_SURROGATE_PROXY` for `surrogate-proxy`.
#[must_use]
pub(crate) fn override_var(id: &str) -> String {
    let suffix: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("{}{suffix}", catalog::env_override_prefix())
}

fn is_off(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "off" | "0" | "false" | "no" | "disabled"
    )
}

/// Lowercase hex sha256 of a file.
///
/// # Errors
///
/// `Io` when the file cannot be read.
pub fn sha256_file(path: &Path) -> Result<String, SettingsError> {
    let bytes = std::fs::read(path)?;
    Ok(hex::encode(Sha256::digest(&bytes)))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), SettingsError> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}
