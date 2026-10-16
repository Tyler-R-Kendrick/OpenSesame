//! Unit tests for [`super`].

#[test]
fn line_one_answers_the_canonical_secret_field_names() {
    for field in ["password", "value", "secret", "credential"] {
        assert_eq!(
            super::entry_field("line-one", "", field).as_deref(),
            Some("line-one"),
            "{field}"
        );
    }
    assert_eq!(super::entry_field("", "", "password"), None);
    assert_eq!(super::entry_field("line-one", "", "username"), None);
}

#[test]
fn trailer_metadata_answers_hidden_fields_and_named_values() {
    let trailer = concat!(
        "{\"kind\":\"secret\",\"v\":2,",
        "\"values\":{\"apiKey\":\"named-value\",\"region\":\"eu\"},",
        "\"fields\":[{\"name\":\"extra\",\"value\":\"hidden-value\",\"hidden\":true},",
        "{\"name\":\"label\",\"value\":\"visible-value\",\"hidden\":false}]}\n",
        "otpauth://totp/example?secret=ABC\n"
    );
    assert_eq!(
        super::entry_field("line-one", trailer, "extra").as_deref(),
        Some("hidden-value")
    );
    assert_eq!(
        super::entry_field("line-one", trailer, "apiKey").as_deref(),
        Some("named-value")
    );
    // A non-concealed custom field is not secret material.
    assert_eq!(super::entry_field("line-one", trailer, "label"), None);
    assert_eq!(super::entry_field("line-one", trailer, "missing"), None);
    assert_eq!(
        super::entry_field("line-one", "freeform notes", "extra"),
        None
    );
}

#[test]
fn template_literals_are_values_but_never_masked_secrets() {
    use opensesame_connector_host::password_agent::env as core;
    use std::collections::HashMap;
    use zeroize::Zeroizing;
    let lines = core::parse("API=os://v/i/f\nPLAIN=ordinary\n");
    let refs = core::references(&lines);
    let resolved: HashMap<String, Zeroizing<String>> = refs
        .into_iter()
        .map(|reference| (reference, Zeroizing::new("private-canary".into())))
        .collect();
    let (values, secrets) = super::template_values(&lines, &resolved);
    assert_eq!(
        values,
        [
            ("API".to_string(), "private-canary".to_string()),
            ("PLAIN".to_string(), "ordinary".to_string())
        ]
    );
    assert_eq!(secrets, ["private-canary".to_string()]);
}

#[test]
fn a_sealed_entry_resolves_through_the_store_the_vault_opens() {
    use opensesame_sealed_store::{init_store, init_store_key, unlock_store_key, Entry};
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"smoke-passphrase").unwrap();
    let trailer =
        "{\"kind\":\"secret\",\"v\":2,\"values\":{\"apiKey\":\"named-canary\"}}\n".to_string();
    root.insert(
        "Dev/token",
        &Entry {
            secret: "line-one-canary".into(),
            trailer,
            otp: None,
        },
        &key,
    )
    .unwrap();
    // The exact calls LocalVault makes after the passphrase prompt.
    let unlocked = unlock_store_key(dir.path(), b"smoke-passphrase").unwrap();
    let entry = root
        .show_with_age_identity("Dev/token", &unlocked, None)
        .unwrap();
    assert_eq!(
        super::entry_field(&entry.secret, &entry.trailer, "password").as_deref(),
        Some("line-one-canary")
    );
    assert_eq!(
        super::entry_field(&entry.secret, &entry.trailer, "apiKey").as_deref(),
        Some("named-canary")
    );
    assert!(unlock_store_key(dir.path(), b"wrong-passphrase").is_err());
}
