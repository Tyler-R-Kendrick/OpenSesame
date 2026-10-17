//! `BrokerConfig` unit tests, beside `config.rs` so the module stays inside
//! its size budget (ADR 0093).

use super::*;
use crate::catalog;

fn key() -> [u8; 32] {
    [7u8; 32]
}

#[test]
fn env_var_names_follow_the_provider_id() {
    assert_eq!(
        env_var_name("github", "CLIENT_ID"),
        "OPENSESAME_PROVIDER_GITHUB_CLIENT_ID"
    );
    assert_eq!(
        env_var_name("mock-idp", "TOKEN_URL"),
        "OPENSESAME_PROVIDER_MOCK_IDP_TOKEN_URL"
    );
}

#[test]
fn no_key_means_nothing_is_configured() {
    let cfg = BrokerConfig::in_memory(None, "http://127.0.0.1:8787");
    for p in catalog::all().expect("catalog") {
        assert!(!cfg.configured(p), "{} claimed configured", p.id);
        assert!(
            cfg.missing_config(p)
                .contains(&ENV_CONNECTION_KEY.to_string()),
            "{} did not name the key variable",
            p.id
        );
    }
}

/// Whatever is reported missing must be a variable a deployment can actually set.
#[test]
fn missing_config_names_real_variables() {
    let cfg = BrokerConfig::in_memory(Some(key()), "http://127.0.0.1:8787");
    for p in catalog::all().expect("catalog") {
        let missing = cfg.missing_config(p);
        if p.auth.requires_client_credentials() {
            assert_eq!(
                missing,
                vec![
                    env_var_name(&p.id, "CLIENT_ID"),
                    env_var_name(&p.id, "CLIENT_SECRET")
                ],
                "{}",
                p.id
            );
        } else {
            assert!(missing.is_empty(), "{} wants {missing:?}", p.id);
        }
        for name in missing {
            assert!(name.starts_with("OPENSESAME_"), "{name}");
            assert!(!name.contains('-'), "{name}");
        }
    }
}

#[test]
fn a_configured_oauth_provider_reports_clean() {
    let cfg = BrokerConfig::in_memory(Some(key()), "http://127.0.0.1:8787").with_provider(
        "github",
        ProviderConfig {
            client_id: Some("id".into()),
            client_secret: Some("secret".into()),
            ..Default::default()
        },
    );
    let github = catalog::find("github").expect("catalog").expect("github");
    assert!(cfg.configured(github));
    assert!(cfg.missing_config(github).is_empty());
}

#[test]
fn only_our_callback_and_allowlisted_origins_are_redirect_targets() {
    let cfg = BrokerConfig::in_memory(Some(key()), "http://127.0.0.1:8787/")
        .with_redirect_allowlist(vec!["https://app.example".into()]);
    assert!(cfg.redirect_allowed(
        "github",
        "http://127.0.0.1:8787/api/v1/oauth/callback/github"
    ));
    assert!(cfg.redirect_allowed("github", "https://app.example/done"));
    assert!(!cfg.redirect_allowed("github", "https://evil.example/steal"));
    assert!(!cfg.redirect_allowed("github", "not a url"));
}

#[test]
fn endpoint_overrides_win_over_the_catalog() {
    let mock = catalog::find("mock").expect("catalog").expect("mock");
    let cfg = BrokerConfig::in_memory(Some(key()), "http://127.0.0.1:8787").with_provider(
        "mock",
        ProviderConfig {
            token_url: Some("http://127.0.0.1:1/token".into()),
            ..Default::default()
        },
    );
    assert_eq!(
        cfg.token_url(mock).as_deref(),
        Some("http://127.0.0.1:1/token")
    );
    assert_eq!(
        cfg.authorize_url(mock).as_deref(),
        Some(catalog::MOCK_AUTHORIZE_URL)
    );
    let workos = catalog::find("workos").expect("catalog").expect("workos");
    assert!(cfg.token_url(workos).is_none());
}

#[test]
fn common_environment_names_and_safe_defaults_are_detected() {
    let values = BTreeMap::from([
        ("BETTER_AUTH_URL", "https://identity.example/api/auth"),
        ("BETTER_AUTH_API_KEY", "better-secret"),
        ("WORKOS_API_KEY", "workos-secret"),
        ("AUTH0_DOMAIN", "https://tenant.us.auth0.com/"),
        ("AUTH0_CLIENT_ID", "client"),
        ("AUTH0_CLIENT_SECRET", "auth0-secret"),
    ]);
    let read_env = |name: &str| values.get(name).map(|value| (*value).to_string());
    let read_file = |_path: &PathBuf| None;
    let better_auth = catalog::find("better-auth").unwrap().unwrap();
    assert_eq!(
        detect_connection_configuration_with(better_auth, &read_env, &read_file).unwrap(),
        BTreeMap::from([
            (
                "base_url".into(),
                "https://identity.example/api/auth".into()
            ),
            ("api_key".into(), "better-secret".into()),
            ("api_key_header".into(), "x-api-key".into()),
            ("config_id".into(), "default".into()),
        ])
    );
    let workos = catalog::find("workos").unwrap().unwrap();
    assert_eq!(
        detect_connection_configuration_with(workos, &read_env, &read_file).unwrap(),
        BTreeMap::from([("api_key".into(), "workos-secret".into())])
    );
    let auth0 = catalog::find("auth0").unwrap().unwrap();
    assert_eq!(
        detect_connection_configuration_with(auth0, &read_env, &read_file).unwrap(),
        BTreeMap::from([
            ("domain".into(), "tenant.us.auth0.com".into()),
            ("client_id".into(), "client".into()),
            ("client_secret".into(), "auth0-secret".into()),
            (
                "audience".into(),
                "https://tenant.us.auth0.com/api/v2/".into()
            ),
        ])
    );
}

#[test]
fn host_files_are_detected_without_exposing_partial_configuration() {
    let values = BTreeMap::from([("HOME", "/host-user")]);
    let read_env = |name: &str| values.get(name).map(|value| (*value).to_string());
    let read_file = |path: &PathBuf| {
        (path == &PathBuf::from("/host-user/.vault-token")).then(|| "vault-secret\n".into())
    };
    let vault = catalog::find("vault").unwrap().unwrap();
    assert_eq!(
        detect_connection_configuration_with(vault, &read_env, &read_file).unwrap(),
        BTreeMap::from([
            ("address".into(), "http://127.0.0.1:8200".into()),
            ("token".into(), "vault-secret".into()),
        ])
    );

    let no_files = |_path: &PathBuf| None;
    assert!(detect_connection_configuration_with(vault, &read_env, &no_files).is_none());
}

#[test]
fn the_selected_aws_profile_is_detected_from_standard_files() {
    let values = BTreeMap::from([("HOME", "/host-user"), ("AWS_PROFILE", "work")]);
    let read_env = |name: &str| values.get(name).map(|value| (*value).to_string());
    let read_file = |path: &PathBuf| match path.to_string_lossy().as_ref() {
        "/host-user/.aws/credentials" => Some(
            "[work]\naws_access_key_id = detected-id\naws_secret_access_key = detected-secret\n"
                .into(),
        ),
        "/host-user/.aws/config" => Some("[profile work]\nregion = us-west-2\n".into()),
        _ => None,
    };
    let aws = catalog::find("aws").unwrap().unwrap();
    assert_eq!(
        detect_connection_configuration_with(aws, &read_env, &read_file).unwrap(),
        BTreeMap::from([
            ("region".into(), "us-west-2".into()),
            ("access_key_id".into(), "detected-id".into()),
            ("secret_access_key".into(), "detected-secret".into()),
        ])
    );
}

#[test]
fn aws_key_pairs_never_mix_environment_and_profile_values() {
    let file = |path: &PathBuf| {
        (path == &PathBuf::from("/host-user/.aws/credentials")).then(|| {
            "[default]\naws_access_key_id = file-id\naws_secret_access_key = file-secret\n".into()
        })
    };
    let aws = catalog::find("aws").unwrap().unwrap();
    let partial = BTreeMap::from([
        ("HOME", "/host-user"),
        ("AWS_REGION", "us-east-1"),
        ("AWS_ACCESS_KEY_ID", "environment-id"),
    ]);
    assert!(detect_connection_configuration_with(
        aws,
        &|name| partial.get(name).map(|value| (*value).to_string()),
        &file,
    )
    .is_none());

    let complete = BTreeMap::from([
        ("HOME", "/host-user"),
        ("AWS_REGION", "us-east-1"),
        ("AWS_ACCESS_KEY_ID", "environment-id"),
        ("AWS_SECRET_ACCESS_KEY", "environment-secret"),
    ]);
    let detected = detect_connection_configuration_with(
        aws,
        &|name| complete.get(name).map(|value| (*value).to_string()),
        &file,
    )
    .unwrap();
    assert_eq!(detected["access_key_id"], "environment-id");
    assert_eq!(detected["secret_access_key"], "environment-secret");
}

#[test]
fn gcp_application_credentials_supply_the_project_and_sealed_json() {
    let values = BTreeMap::from([("GOOGLE_APPLICATION_CREDENTIALS", "/credentials/gcp.json")]);
    let read_env = |name: &str| values.get(name).map(|value| (*value).to_string());
    let read_file = |path: &PathBuf| {
        (path == &PathBuf::from("/credentials/gcp.json"))
            .then(|| r#"{"type":"service_account","project_id":"demo-project"}"#.into())
    };
    let gcp = catalog::find("gcp").unwrap().unwrap();
    let detected = detect_connection_configuration_with(gcp, &read_env, &read_file).unwrap();
    assert_eq!(detected["project_id"], "demo-project");
    assert!(detected["service_account_json"].contains("service_account"));
}

#[test]
fn a_key_of_the_wrong_length_is_refused() {
    assert!(decode_key("c2hvcnQ=").is_err());
    let ok = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [1u8; 32]);
    assert_eq!(decode_key(&ok).unwrap(), [1u8; 32]);
}
