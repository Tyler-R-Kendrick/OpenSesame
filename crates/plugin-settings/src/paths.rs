//! Where a plugin keeps what it writes while it runs, derived from the
//! settings file so every reader — the plugin, the `opensesame` CLI and the
//! daemon's Settings routes — agrees without a second configuration value.
//!
//! ```text
//! <dir of plugins.json>/plugin-state/<id>/notices.jsonl   refusal notices
//! <dir of plugins.json>/plugin-state/<id>/runs/<run>/     one run's CA file
//! ```
//!
//! Only a catalog id resolves, so a caller-supplied id can never name a path
//! outside `plugin-state/`.

use std::path::{Path, PathBuf};

use crate::catalog;
use crate::settings::SettingsError;

/// The directory name beside the settings file.
pub const STATE_DIR_NAME: &str = "plugin-state";

/// The notices file inside a plugin's state directory: one vetted
/// `SecurityNotice` per line, never a surrogate or a credential.
pub const NOTICES_FILE: &str = "notices.jsonl";

/// The rotated predecessor of [`NOTICES_FILE`].
pub const NOTICES_ROTATED_FILE: &str = "notices.jsonl.1";

/// The evidence file beside [`NOTICES_FILE`]: the Error-and-above notices, in
/// a file that lower-severity traffic never rotates.
pub const TRIPWIRES_FILE: &str = "tripwires.jsonl";

/// `<dir of settings_path>/plugin-state/<id>`.
///
/// # Errors
///
/// `UnknownPlugin` for an id the catalog does not name.
pub fn plugin_state_dir(settings_path: &Path, id: &str) -> Result<PathBuf, SettingsError> {
    let row = catalog::find(id).ok_or_else(|| SettingsError::UnknownPlugin(id.to_string()))?;
    let base = settings_path.parent().unwrap_or_else(|| Path::new("."));
    Ok(base.join(STATE_DIR_NAME).join(row.id))
}

/// `<plugin state dir>/notices.jsonl`.
///
/// # Errors
///
/// `UnknownPlugin` for an id the catalog does not name.
pub fn notices_path(settings_path: &Path, id: &str) -> Result<PathBuf, SettingsError> {
    Ok(plugin_state_dir(settings_path, id)?.join(NOTICES_FILE))
}

/// `<plugin state dir>/tripwires.jsonl`.
///
/// # Errors
///
/// `UnknownPlugin` for an id the catalog does not name.
pub fn tripwires_path(settings_path: &Path, id: &str) -> Result<PathBuf, SettingsError> {
    Ok(plugin_state_dir(settings_path, id)?.join(TRIPWIRES_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_lives_beside_the_settings_file() {
        let settings = Path::new("/cfg/opensesame/plugins.json");
        assert_eq!(
            notices_path(settings, "surrogate-proxy").unwrap(),
            Path::new("/cfg/opensesame/plugin-state/surrogate-proxy/notices.jsonl")
        );
    }

    #[test]
    fn a_traversing_id_names_no_path() {
        let settings = Path::new("/cfg/plugins.json");
        for id in ["../../etc", "surrogate-proxy/../x", "", "/abs"] {
            assert!(matches!(
                plugin_state_dir(settings, id),
                Err(SettingsError::UnknownPlugin(_))
            ));
        }
    }
}
