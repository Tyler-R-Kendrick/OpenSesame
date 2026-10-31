//! The age localization build uses i18n-config. Keep its TOML migration compatible.

use std::{fs, path::PathBuf};

use i18n_config::{I18nConfig, I18nConfigError};

fn parse(source: &str) -> Result<I18nConfig, I18nConfigError> {
    let dir = tempfile::tempdir().expect("temporary config directory");
    let path = dir.path().join("i18n.toml");
    fs::write(&path, source).expect("write config");
    I18nConfig::from_file(path)
}

#[test]
fn age_fluent_config_preserves_language_assets_and_optional_domain() {
    // This is age's configuration shape, with optional paths/domain exercised too.
    let config = parse(
        r#"
fallback_language = "en-US"
subcrates = ["child", "another child"]

[fluent]
assets_dir = "i18n"
domain = "age"
"#,
    )
    .expect("supported Fluent configuration");
    assert_eq!(config.fallback_language.to_string(), "en-US");
    assert_eq!(
        config.subcrates,
        vec![PathBuf::from("child"), PathBuf::from("another child")]
    );
    let fluent = config.fluent.expect("Fluent configuration");
    assert_eq!(fluent.assets_dir, PathBuf::from("i18n"));
    assert_eq!(fluent.domain.as_deref(), Some("age"));
    assert!(config.gettext.is_none());
}

#[test]
fn age_minimal_config_keeps_omitted_defaults() {
    let config = parse("fallback_language = 'en-US'\n[fluent]\nassets_dir = 'i18n'\n")
        .expect("age localization configuration");
    assert!(config.subcrates.is_empty());
    assert!(config
        .fluent
        .expect("Fluent configuration")
        .domain
        .is_none());
}

#[test]
fn duplicate_fields_invalid_languages_and_missing_required_values_are_rejected() {
    for source in [
        "fallback_language = 'en-US'\nfallback_language = 'de-DE'\n",
        "fallback_language = 'not a language'\n",
        "[fluent]\nassets_dir = 'i18n'\n",
        "fallback_language = 'en-US'\n[fluent]\ndomain = 'age'\n",
        "fallback_language = 'en-US'\n[fluent\nassets_dir = 'i18n'\n",
    ] {
        assert!(
            matches!(
                parse(source),
                Err(I18nConfigError::CannotDeserializeToml(..))
            ),
            "accepted invalid configuration: {source}"
        );
    }
}
