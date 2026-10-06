use super::*;

fn oauth() -> Credential {
    Credential {
        kind: CredentialKind::Oauth,
        client_id: "kAbC123CNTRL".into(),
    }
}

#[test]
fn connect_records_the_tailnet_and_keeps_the_secret_apart() {
    let tmp = tempfile::tempdir().unwrap();
    let store = AdminStore::at(tmp.path());
    assert_eq!(store.config().unwrap(), None);
    let secret = SecretString::from("tskey-client-kAbC123CNTRL-0123456789abcdef".to_string());
    let config = store.connect("example.com", oauth(), &secret, 7).unwrap();
    assert_eq!(store.config().unwrap(), Some(config.clone()));
    let json = std::fs::read_to_string(tmp.path().join(CONFIG_FILE)).unwrap();
    assert!(
        !json.contains("tskey-"),
        "the config file never holds the secret"
    );
    let read = store.secret(&config).unwrap();
    assert_eq!(read.expose_secret(), secret.expose_secret());
    assert!(store.disconnect().unwrap());
    assert_eq!(store.config().unwrap(), None);
    assert!(matches!(
        store.secret(&config),
        Err(AdminError::NotConnected)
    ));
    assert!(!store.disconnect().unwrap());
}

#[test]
fn connect_refuses_what_tailscale_never_issues() {
    let tmp = tempfile::tempdir().unwrap();
    let store = AdminStore::at(tmp.path());
    let good = SecretString::from("tskey-client-abc-0123456789".to_string());
    let api = Credential {
        kind: CredentialKind::ApiKey,
        client_id: String::new(),
    };
    let cases: [(&str, Credential, &str, &str); 5] = [
        (
            "../etc",
            oauth(),
            "tskey-client-abc-0123456789",
            "invalid_tailnet",
        ),
        (
            "-",
            api.clone(),
            "tskey-client-abc-0123456789",
            "invalid_credential",
        ),
        (
            "-",
            oauth(),
            "tskey-api-abc-0123456789",
            "invalid_credential",
        ),
        (
            "-",
            Credential {
                kind: CredentialKind::Oauth,
                client_id: String::new(),
            },
            "tskey-client-abc-0123456789",
            "invalid_client_id",
        ),
        (
            "-",
            Credential {
                kind: CredentialKind::ApiKey,
                client_id: "x".into(),
            },
            "tskey-api-abc-0123456789",
            "invalid_client_id",
        ),
    ];
    for (tailnet, credential, secret, code) in cases {
        let error = store
            .connect(
                tailnet,
                credential,
                &SecretString::from(secret.to_string()),
                1,
            )
            .unwrap_err();
        assert_eq!(error.code(), code);
    }
    assert!(store.connect("-", oauth(), &good, 1).is_ok());
    assert!(store
        .connect(
            "user@example.com",
            api,
            &SecretString::from("tskey-api-k1-abcdefgh".to_string()),
            1
        )
        .is_ok());
}
