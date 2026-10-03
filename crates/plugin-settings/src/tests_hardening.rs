//! Adversarial-review findings on the settings file and its environment
//! switches: the kill switch fails toward off, no environment relocates the
//! file in a shipped build, concurrent writers lose nothing, and a file
//! writable by others is not trusted.

use super::*;

fn no_env(_: &str) -> Option<String> {
    None
}

fn on_settings() -> PluginSettings {
    let mut settings = PluginSettings::default();
    settings
        .record_install("surrogate-proxy", "0.1.0", &"a".repeat(64), "/x")
        .unwrap();
    settings.set_enabled("surrogate-proxy", true).unwrap();
    settings
}

#[test]
fn any_unrecognised_override_value_turns_the_plugin_off() {
    let settings = on_settings();
    for value in [
        "disable",
        "deny",
        "never",
        "n",
        "nope",
        "disabled_by_ops",
        "off",
        "maybe",
        "2",
    ] {
        let env = |k: &str| (k == "OPENSESAME_PLUGIN_SURROGATE_PROXY").then(|| value.to_string());
        let state = settings.state("surrogate-proxy", env).unwrap();
        assert!(state.forced_off && !state.active, "{value:?} must be off");
    }
}

#[test]
fn only_an_explicit_allow_value_or_nothing_leaves_the_file_in_charge() {
    let settings = on_settings();
    for value in ["", "   ", "on", "ON", "1", "true", "yes", " Yes "] {
        let env = |k: &str| (k == "OPENSESAME_PLUGIN_SURROGATE_PROXY").then(|| value.to_string());
        let state = settings.state("surrogate-proxy", env).unwrap();
        assert!(!state.forced_off && state.active, "{value:?} is not an off");
    }
    assert!(settings.state("surrogate-proxy", no_env).unwrap().active);
}

#[cfg(not(feature = "path-override"))]
#[test]
fn a_shipped_build_takes_the_settings_path_from_no_environment() {
    let forged = |k: &str| (k == SETTINGS_PATH_ENV).then(|| "/tmp/forged/plugins.json".to_string());
    let path = settings_path_from(forged).unwrap();
    assert_ne!(path, std::path::Path::new("/tmp/forged/plugins.json"));
    assert!(path.ends_with("plugins.json"));
}

#[cfg(feature = "path-override")]
#[test]
fn the_test_feature_is_the_only_way_to_relocate_the_file() {
    let forged = |k: &str| (k == SETTINGS_PATH_ENV).then(|| "/tmp/forged/plugins.json".to_string());
    assert_eq!(
        settings_path_from(forged).unwrap(),
        std::path::Path::new("/tmp/forged/plugins.json")
    );
}

#[test]
fn concurrent_updates_each_survive() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugins.json");
    let threads: Vec<_> = (0..12)
        .map(|i| {
            let path = path.clone();
            std::thread::spawn(move || {
                let id = if i % 2 == 0 {
                    "surrogate-proxy"
                } else {
                    "browser-autofill"
                };
                PluginSettings::update(&path, |settings| {
                    settings.record_install(id, "1", &"b".repeat(64), "/y")
                })
                .unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let loaded = PluginSettings::load(&path).unwrap();
    assert_eq!(loaded.plugins.len(), 2, "an install record was lost");
}

#[test]
fn concurrent_installs_of_different_plugins_both_land() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugins.json");
    let ids = ["surrogate-proxy", "browser-autofill"];
    let threads: Vec<_> = (0..40)
        .map(|i| {
            let path = path.clone();
            std::thread::spawn(move || {
                PluginSettings::update(&path, |settings| {
                    if settings.plugins.len() < 2 || i % 2 == 0 {
                        settings.record_install(ids[i % 2], "1", &"d".repeat(64), "/q")?;
                    }
                    Ok(())
                })
                .unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(PluginSettings::load(&path).unwrap().plugins.len(), 2);
}

#[test]
fn a_stale_lock_does_not_wedge_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugins.json");
    let lock = dir.path().join("plugins.json.lock");
    std::fs::write(&lock, b"").unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
    std::fs::File::options()
        .write(true)
        .open(&lock)
        .unwrap()
        .set_modified(old)
        .unwrap();
    PluginSettings::update(&path, |settings| {
        settings.record_install("surrogate-proxy", "1", &"c".repeat(64), "/z")
    })
    .unwrap();
    assert!(PluginSettings::load(&path)
        .unwrap()
        .plugins
        .contains_key("surrogate-proxy"));
}

#[cfg(unix)]
#[test]
fn a_file_others_can_write_is_not_trusted() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugins.json");
    on_settings().save(&path).unwrap();
    assert!(PluginSettings::load(&path).is_ok());
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(matches!(
        PluginSettings::load(&path),
        Err(SettingsError::Unreadable(_))
    ));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o620)).unwrap();
    assert!(PluginSettings::load(&path).is_err());
}
