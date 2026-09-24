use super::*;

#[test]
fn embedded_catalog_is_valid_and_versioned() {
    let catalog = load().expect("embedded catalog");
    assert_eq!(catalog.revision(), "2026-09-24.1");
    assert_eq!(catalog.providers().len(), 111);
    assert_eq!(
        catalog
            .providers()
            .iter()
            .filter(|provider| provider.id != "mock")
            .count(),
        110
    );
    assert_eq!(catalog.find("github").unwrap().display_name, "GitHub");
}

#[test]
fn certificate_connections_are_capability_scoped() {
    let catalog = load().expect("embedded catalog");
    let letsencrypt = catalog.find("letsencrypt").expect("letsencrypt");
    assert!(matches!(letsencrypt.auth, AuthMethod::Configuration));
    assert_eq!(
        letsencrypt.egress.authorities,
        [
            "acme-v02.api.letsencrypt.org",
            "acme-staging-v02.api.letsencrypt.org"
        ]
    );

    let zerossl = catalog.find("zerossl").expect("zerossl");
    assert!(zerossl
        .connection_configuration_fields()
        .iter()
        .any(|field| field.name == "eab_hmac_key" && field.secret));

    let cloudflare = catalog.find("cloudflare").expect("cloudflare");
    assert!(cloudflare
        .operations
        .iter()
        .any(|operation| operation == "acme_dns_challenge.write"));
    assert!(!cloudflare
        .operations
        .iter()
        .any(|operation| operation == "certificate.origin.issue"));
    let origin = catalog
        .find("cloudflare-origin-ca")
        .expect("cloudflare origin CA");
    assert!(origin
        .operations
        .iter()
        .any(|operation| operation == "certificate.origin.issue"));
    assert_eq!(origin.egress.path_prefixes, ["/client/v4/certificates"]);
}

#[test]
fn catalog_covers_every_fnox_provider_type() {
    let expected = [
        ("age", Category::Encryption),
        ("fido2", Category::Encryption),
        ("yubikey", Category::Encryption),
        ("aws-kms", Category::Encryption),
        ("azure-kms", Category::Encryption),
        ("gcp-kms", Category::Encryption),
        ("aws-ps", Category::CloudSecretStorage),
        ("aws", Category::CloudSecretStorage),
        ("azure-ac", Category::CloudSecretStorage),
        ("azure-sm", Category::CloudSecretStorage),
        ("gcp", Category::CloudSecretStorage),
        ("doppler", Category::CloudSecretStorage),
        ("foks", Category::CloudSecretStorage),
        ("bitwarden-sm", Category::CloudSecretStorage),
        ("vault", Category::CloudSecretStorage),
        ("openbao", Category::CloudSecretStorage),
        ("encrypted-remote", Category::CloudSecretStorage),
        ("1password", Category::PasswordManagers),
        ("bitwarden", Category::PasswordManagers),
        ("vaultwarden", Category::PasswordManagers),
        ("infisical", Category::PasswordManagers),
        ("proton-pass", Category::PasswordManagers),
        ("passwordstate", Category::PasswordManagers),
        ("keychain", Category::LocalStorage),
        ("keepass", Category::LocalStorage),
        ("password-store", Category::LocalStorage),
        ("sealed-local", Category::LocalStorage),
        ("plain", Category::LocalStorage),
    ];
    let catalog = load().expect("embedded catalog");
    for (id, category) in expected {
        let provider = catalog
            .find(id)
            .unwrap_or_else(|| panic!("missing Fnox provider {id}"));
        assert_eq!(provider.category, category, "wrong category for {id}");
        // Doppler is promoted to real API-key auth with value-blind
        // egress (ADR 0065 §8); the rest stay configuration-only until
        // their own promotion review.
        if id == "doppler" {
            assert!(matches!(&provider.auth, AuthMethod::ApiKey { .. }));
        } else {
            assert!(matches!(&provider.auth, AuthMethod::Configuration));
        }
    }
}

/// The promoted doppler row must stay value-blind: its egress prefixes
/// allow the metadata endpoints and structurally exclude the
/// secret-*values* endpoint, which no L2 caller may ever reach.
#[test]
fn doppler_promotion_is_value_blind() {
    let catalog = load().expect("embedded catalog");
    let doppler = catalog.find("doppler").expect("doppler provider");
    assert!(matches!(&doppler.auth, AuthMethod::ApiKey { .. }));
    let binding = doppler.egress.binding();
    assert!(binding
        .allows_url("https://api.doppler.com/v3/projects")
        .is_ok());
    assert!(binding
        .allows_url("https://api.doppler.com/v3/configs/config/secrets/names?project=a&config=b")
        .is_ok());
    // The values endpoint is the whole point of the fence.
    assert!(binding
        .allows_url("https://api.doppler.com/v3/configs/config/secrets?project=a&config=b")
        .is_err());
    assert!(binding
        .allows_url("https://api.doppler.com/v3/configs/config/secret?name=X")
        .is_err());
    assert!(!doppler
        .operations
        .iter()
        .any(|op| op == "secret.read" || op == "secret.download"));
}

/// Passbolt is not an fnox provider: it is a self-hosted, PGP-keyed
/// password manager whose connection is configured, not OAuth'd. The row
/// must survive the strict loader with its two secret fields intact, and
/// must claim no egress — the server URL is user-supplied, so a static
/// allowlist cannot enumerate it (see the client-side pinning rule).
#[test]
fn passbolt_round_trips_through_the_strict_loader() {
    let catalog = load().expect("embedded catalog");
    let passbolt = catalog.find("passbolt").expect("passbolt provider");
    assert_eq!(passbolt.category, Category::PasswordManagers);
    assert!(matches!(&passbolt.auth, AuthMethod::Configuration));
    let fields: Vec<(&str, bool, bool)> = passbolt
        .connection_configuration_fields()
        .iter()
        .map(|field| (field.name.as_str(), field.secret, field.required))
        .collect();
    assert_eq!(
        fields,
        vec![
            ("server_url", false, true),
            ("private_key", true, true),
            ("passphrase", true, true),
        ]
    );
    assert_eq!(passbolt.egress.scheme, "none");
    assert!(passbolt.egress.authorities.is_empty());
    assert!(passbolt.egress.path_prefixes.is_empty());
    assert!(passbolt.scopes.is_empty());
    assert_eq!(passbolt.operations, vec!["secret.configure".to_string()]);

    // The row survives a parse of the document it came from, so the
    // committed JSON is what the loader accepts, not a hand-built struct.
    let reparsed = Catalog::parse(CATALOG_JSON).expect("reparse");
    assert_eq!(reparsed.find("passbolt"), Some(passbolt));
}

#[test]
fn catalog_includes_required_llm_providers() {
    let expected = [
        "anthropic",
        "openai",
        "azure-openai",
        "aws-bedrock",
        "openrouter",
        "huggingface",
    ];
    let catalog = load().expect("embedded catalog");
    for id in expected {
        assert_eq!(catalog.find(id).unwrap().category, Category::AgentHarnesses);
    }
}

#[test]
fn catalog_includes_required_identity_providers() {
    let catalog = load().expect("embedded catalog");
    for id in ["better-auth", "workos", "auth0"] {
        let provider = catalog
            .find(id)
            .unwrap_or_else(|| panic!("missing identity provider {id}"));
        assert_eq!(provider.category, Category::Identity);
    }
    assert!(matches!(
        &catalog.find("workos").unwrap().auth,
        AuthMethod::ApiKey { header, value_prefix }
            if header == "Authorization" && value_prefix == "Bearer "
    ));
    for id in ["better-auth", "auth0"] {
        assert!(matches!(
            &catalog.find(id).unwrap().auth,
            AuthMethod::Configuration
        ));
    }
}

#[test]
fn empty_and_invalid_catalogs_fail_closed() {
    let empty = r#"{"schema_version":1,"revision":"test.1","providers":[]}"#;
    assert_eq!(
        Catalog::parse(empty).unwrap_err().to_string(),
        "catalog has no providers"
    );

    let mut invalid: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
    invalid["providers"][0]["egress"]["authorities"] = serde_json::json!([]);
    assert!(Catalog::parse(&invalid.to_string())
        .unwrap_err()
        .to_string()
        .contains("egress authorities"));
}

#[test]
fn duplicate_ids_and_unknown_fields_are_rejected() {
    let mut duplicate: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
    duplicate["providers"][1]["id"] = duplicate["providers"][0]["id"].clone();
    assert!(Catalog::parse(&duplicate.to_string())
        .unwrap_err()
        .to_string()
        .contains("duplicate provider id"));

    let mut unknown: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
    unknown["providers"][0]["secret"] = serde_json::json!("must not be accepted");
    assert!(Catalog::parse(&unknown.to_string())
        .unwrap_err()
        .to_string()
        .contains("unknown field"));
}

#[test]
fn sensitive_scopes_cannot_be_defaults() {
    let mut invalid: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
    invalid["providers"][0]["scopes"][1]["default"] = serde_json::json!(true);
    assert!(Catalog::parse(&invalid.to_string())
        .unwrap_err()
        .to_string()
        .contains("sensitive scope `repo` cannot be a default"));
}

#[test]
fn an_alias_resolves_to_its_row_and_never_collides() {
    let aws = resolve("aws-secrets-manager").unwrap().unwrap();
    assert_eq!(aws.id, "aws");
    assert_eq!(resolve("aws").unwrap().unwrap().id, "aws");
    assert!(resolve("no-such-provider").unwrap().is_none());

    let mut raw: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
    raw["providers"][0]["aliases"] = serde_json::json!(["aws"]);
    let error = Catalog::parse(&raw.to_string()).unwrap_err();
    assert!(
        error.to_string().contains("repeats an id or alias"),
        "{error}"
    );
}
