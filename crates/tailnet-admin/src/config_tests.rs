use super::*;
use crate::synthetic::{api_token, client_id, client_secret};

fn oauth() -> Credential {
    Credential {
        kind: CredentialKind::Oauth,
        client_id: client_id(),
    }
}

#[test]
fn connect_records_the_tailnet_and_keeps_the_secret_apart() {
    let tmp = tempfile::tempdir().unwrap();
    let store = AdminStore::at(tmp.path());
    assert_eq!(store.config().unwrap(), None);
    let secret = client_secret();
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
    let api = Credential {
        kind: CredentialKind::ApiKey,
        client_id: String::new(),
    };
    let cases: [(&str, Credential, fn() -> SecretString, &str); 5] = [
        ("../etc", oauth(), client_secret, "invalid_tailnet"),
        ("-", api.clone(), client_secret, "invalid_credential"),
        ("-", oauth(), api_token, "invalid_credential"),
        (
            "-",
            Credential {
                kind: CredentialKind::Oauth,
                client_id: String::new(),
            },
            client_secret,
            "invalid_client_id",
        ),
        (
            "-",
            Credential {
                kind: CredentialKind::ApiKey,
                client_id: "x".into(),
            },
            api_token,
            "invalid_client_id",
        ),
    ];
    for (tailnet, credential, secret, code) in cases {
        let error = store
            .connect(tailnet, credential, &secret(), 1)
            .unwrap_err();
        assert_eq!(error.code(), code);
    }
    assert!(store.connect("-", oauth(), &client_secret(), 1).is_ok());
    assert!(store
        .connect("user@example.com", api, &api_token(), 1)
        .is_ok());
}
