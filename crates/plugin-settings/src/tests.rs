//! The three rules (off unless recorded on; the environment only turns off;
//! verified at every launch), plus the catalog's own invariants.

use super::*;
use crate::settings::{override_var, sha256_file};

fn no_env(_: &str) -> Option<String> {
    None
}

fn installed(dir: &std::path::Path) -> (PluginSettings, std::path::PathBuf) {
    let bin = dir.join("opensesame-surrogate-proxy");
    std::fs::write(&bin, b"#!/bin/sh\necho plugin\n").unwrap();
    let pin = sha256_file(&bin).unwrap();
    let mut settings = PluginSettings::default();
    settings
        .record_install("surrogate-proxy", "0.1.0", &pin, bin.to_str().unwrap())
        .unwrap();
    (settings, bin)
}

#[test]
fn every_catalog_plugin_is_off_by_default_and_names_a_capability() {
    let plugins = catalog();
    assert!(!plugins.is_empty());
    for plugin in &plugins {
        assert!(!plugin.default_enabled, "{} must default off", plugin.id);
        assert!(!plugin.capability.is_empty());
        assert_eq!(plugin.adr, "0150");
        match plugin.kind {
            PluginKind::NativeBinary => assert!(plugin.binary.is_some()),
            PluginKind::BrowserExtension => assert!(plugin.package.is_some()),
        }
    }
}

#[test]
fn nothing_installed_means_nothing_active() {
    let dir = tempfile::tempdir().unwrap();
    let settings = PluginSettings::load(&dir.path().join("plugins.json")).unwrap();
    for state in settings.states(no_env) {
        assert!(
            !state.installed && !state.enabled && !state.active,
            "{state:?}"
        );
    }
}

#[test]
fn installing_never_switches_a_plugin_on() {
    let dir = tempfile::tempdir().unwrap();
    let (mut settings, bin) = installed(dir.path());
    settings.set_enabled("surrogate-proxy", true).unwrap();
    // A reinstall (an upgrade) records it off again.
    let pin = sha256_file(&bin).unwrap();
    settings
        .record_install("surrogate-proxy", "0.2.0", &pin, bin.to_str().unwrap())
        .unwrap();
    let state = settings.state("surrogate-proxy", no_env).unwrap();
    assert!(state.installed && !state.enabled && !state.active);
}

#[test]
fn the_environment_can_turn_a_plugin_off_but_never_on() {
    let dir = tempfile::tempdir().unwrap();
    let (mut settings, _) = installed(dir.path());
    assert_eq!(
        override_var("surrogate-proxy"),
        "OPENSESAME_PLUGIN_SURROGATE_PROXY"
    );
    let on = |_: &str| Some("on".to_string());
    // Recorded off: "on" in the environment changes nothing.
    assert!(!settings.state("surrogate-proxy", on).unwrap().active);
    settings.set_enabled("surrogate-proxy", true).unwrap();
    assert!(settings.state("surrogate-proxy", no_env).unwrap().active);
    for value in ["off", "OFF", "0", "false", "disabled"] {
        let env = |k: &str| (k == "OPENSESAME_PLUGIN_SURROGATE_PROXY").then(|| value.to_string());
        let state = settings.state("surrogate-proxy", env).unwrap();
        assert!(state.forced_off && !state.active, "{value}");
    }
}

#[test]
fn a_binary_is_verified_at_every_launch_not_only_at_install() {
    let dir = tempfile::tempdir().unwrap();
    let (mut settings, bin) = installed(dir.path());
    // Off: no path is handed out at all.
    assert!(matches!(
        settings.verified_binary("surrogate-proxy", no_env),
        Err(SettingsError::NotInstalled(_))
    ));
    settings.set_enabled("surrogate-proxy", true).unwrap();
    assert_eq!(
        settings.verified_binary("surrogate-proxy", no_env).unwrap(),
        bin
    );
    // Swapped after install: refused, not warned.
    std::fs::write(&bin, b"#!/bin/sh\necho swapped\n").unwrap();
    assert!(matches!(
        settings.verified_binary("surrogate-proxy", no_env),
        Err(SettingsError::PinMismatch { .. })
    ));
}

#[test]
fn unknown_plugins_and_malformed_pins_are_refused() {
    let mut settings = PluginSettings::default();
    assert!(matches!(
        settings.record_install("keylogger", "1", &"a".repeat(64), "/x"),
        Err(SettingsError::UnknownPlugin(_))
    ));
    for pin in ["", "abc", &"A".repeat(64), &"g".repeat(64)] {
        assert!(matches!(
            settings.record_install("surrogate-proxy", "1", pin, "/x"),
            Err(SettingsError::MalformedPin)
        ));
    }
    assert!(matches!(
        settings.set_enabled("surrogate-proxy", true),
        Err(SettingsError::NotInstalled(_))
    ));
}

#[test]
fn the_file_round_trips_privately_and_rejects_a_newer_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("plugins.json");
    let (mut settings, _) = installed(dir.path());
    settings.set_enabled("surrogate-proxy", true).unwrap();
    settings.save(&path).unwrap();
    assert_eq!(PluginSettings::load(&path).unwrap(), settings);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    std::fs::write(&path, br#"{"schema_version":9,"plugins":{}}"#).unwrap();
    assert!(matches!(
        PluginSettings::load(&path),
        Err(SettingsError::UnsupportedSchema(9))
    ));
    std::fs::write(&path, b"not json").unwrap();
    assert!(matches!(
        PluginSettings::load(&path),
        Err(SettingsError::Unreadable(_))
    ));
    assert!(settings.remove("surrogate-proxy"));
    assert!(!settings.remove("surrogate-proxy"));
}
