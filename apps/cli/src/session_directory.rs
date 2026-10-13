//! Session storage follows an explicit config-root override on every platform.
//! Native project-directory defaults remain in force when no override is set.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

pub(crate) fn session_path() -> anyhow::Result<PathBuf> {
    let explicit = std::env::var_os("XDG_CONFIG_HOME");
    let native = if explicit.is_none() {
        directories::ProjectDirs::from("dev", "OpenSesame", "opensesame")
    } else {
        None
    };
    let directory = session_directory(
        explicit.as_deref(),
        native.as_ref().map(directories::ProjectDirs::config_dir),
    )?;
    std::fs::create_dir_all(&directory)?;
    Ok(directory.join("session.json"))
}

/// Pure path selection: an invalid explicit override never falls back elsewhere.
fn session_directory(explicit: Option<&OsStr>, native: Option<&Path>) -> anyhow::Result<PathBuf> {
    if let Some(value) = explicit {
        let root = Path::new(value);
        if value.is_empty() || !root.is_absolute() {
            anyhow::bail!("XDG_CONFIG_HOME must be a nonempty absolute path");
        }
        return Ok(root.join("opensesame"));
    }
    native
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("no project dirs"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute(name: &str) -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(format!("C:\\{name}"))
        }
        #[cfg(not(windows))]
        {
            PathBuf::from(format!("/{name}"))
        }
    }

    #[test]
    fn explicit_absolute_root_wins_over_the_native_project_directory() {
        let root = absolute("explicit-config");
        let native = absolute("native-project-config");
        assert_eq!(
            session_directory(Some(root.as_os_str()), Some(&native)).unwrap(),
            root.join("opensesame")
        );
    }

    #[test]
    fn explicit_absolute_root_does_not_require_a_native_directory() {
        let root = absolute("explicit-config");
        assert_eq!(
            session_directory(Some(root.as_os_str()), None).unwrap(),
            root.join("opensesame")
        );
    }

    #[test]
    fn absent_override_keeps_the_native_project_directory_exactly() {
        let native = absolute("native-project-config");
        assert_eq!(session_directory(None, Some(&native)).unwrap(), native);
        assert!(session_directory(None, None).is_err());
    }

    #[test]
    fn invalid_explicit_paths_refuse_instead_of_reading_a_native_session() {
        let native = absolute("native-project-config");
        for value in ["", ".", "..", "relative/config"] {
            assert!(session_directory(Some(OsStr::new(value)), Some(&native)).is_err());
            assert!(session_directory(Some(OsStr::new(value)), None).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_relative_and_root_relative_overrides_refuse() {
        let native = absolute("native-project-config");
        for value in [r"C:relative", r"\config"] {
            assert!(session_directory(Some(OsStr::new(value)), Some(&native)).is_err());
        }
    }
}
