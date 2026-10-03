use super::*;

const SECRET: &str = "correct-horse-battery-staple";

fn switch(active: bool) -> PluginState {
    PluginState {
        id: "surrogate-proxy".into(),
        capability: "agents.surrogate-credentials".into(),
        installed: true,
        version: Some("1".into()),
        enabled: active,
        forced_off: false,
        active,
    }
}

fn grant(field: &str) -> LoginGrant {
    LoginGrant {
        env_var: "APP_PASSWORD".into(),
        origin: "https://login.example".into(),
        action_path: "/session".into(),
        field: field.into(),
        credential: SecretString::from(SECRET),
        trust: LoginTrust::Webpki,
    }
}

fn armed() -> Arc<RunLogins> {
    RunLogins::arm(&[grant("password")], Some(&switch(true)))
        .unwrap()
        .unwrap()
}

#[test]
fn no_login_arms_nothing() {
    assert!(RunLogins::arm(&[], Some(&switch(true))).unwrap().is_none());
}

#[test]
fn a_switched_off_or_absent_plugin_arms_no_login() {
    assert!(matches!(
        RunLogins::arm(&[grant("password")], Some(&switch(false))),
        Err(LoginError::NotArmed(CdpOnly::SwitchedOff))
    ));
    assert!(matches!(
        RunLogins::arm(&[grant("password")], None),
        Err(LoginError::NotArmed(CdpOnly::NotInstalled))
    ));
}

#[test]
fn a_password_set_field_is_never_a_substitution_site() {
    for field in ["new_password", "password_confirm", "newPassword"] {
        assert!(
            matches!(
                RunLogins::arm(&[grant(field)], Some(&switch(true))),
                Err(LoginError::Declare(DeclareError::PasswordSetField))
            ),
            "{field}"
        );
    }
}

#[test]
fn an_anchor_that_is_not_a_certificate_is_refused() {
    let mut bad = grant("password");
    bad.trust = LoginTrust::Anchor("not a pem".into());
    assert!(matches!(
        RunLogins::arm(&[bad], Some(&switch(true))),
        Err(LoginError::Trust)
    ));
}

#[test]
fn the_child_gets_a_surrogate_never_the_credential() {
    let logins = armed();
    let issued = logins.surrogates();
    assert_eq!(issued.len(), 1);
    assert_eq!(issued[0].0, "APP_PASSWORD");
    assert!(issued[0].1.starts_with("osr_"));
    assert!(!issued[0].1.contains(SECRET));
}

#[test]
fn a_surrogate_is_seen_raw_or_percent_encoded_anywhere_in_a_request() {
    let logins = armed();
    let desk = &logins.desks[0];
    let surrogate = logins.surrogates()[0].1.to_string();
    let encoded = surrogate.replace('_', "%5F");
    let none: [(String, String); 0] = [];
    assert!(desk.appears_in(&format!("https://x.test/?p={encoded}"), &none, b""));
    assert!(desk.appears_in(
        "https://x.test/",
        &[("x-leak".into(), surrogate.clone())],
        b""
    ));
    assert!(desk.appears_in("https://x.test/", &none, surrogate.as_bytes()));
    assert!(!desk.appears_in("https://x.test/", &none, b"password=hunter2"));
}

#[test]
fn revoking_drops_the_declaration_and_every_later_use_reads_revoked() {
    let logins = armed();
    assert_eq!(logins.revoke(), 1);
    assert_eq!(logins.revoke(), 0, "revoking twice revokes nothing new");
    let surrogate = logins.surrogates()[0].1.to_string();
    let body = format!("password={surrogate}");
    let headers = [(
        "content-type".to_owned(),
        "application/x-www-form-urlencoded".to_owned(),
    )];
    let request = LoginRequest {
        method: "POST",
        url: "https://login.example:443/session",
        headers: &headers,
        body: body.as_bytes(),
    };
    assert!(matches!(
        logins.desks[0].egress(&request),
        DeskEgress::Revoked
    ));
}

#[test]
fn debug_never_prints_the_credential_or_the_surrogate() {
    let logins = armed();
    let surrogate = logins.surrogates()[0].1.to_string();
    let shown = format!(
        "{:?} {:?}",
        grant("password"),
        LoginTrust::Anchor(SECRET.into())
    );
    assert!(!shown.contains(SECRET), "{shown}");
    assert!(!shown.contains(&surrogate), "{shown}");
}

#[test]
fn percent_decoding_is_one_layer_and_leaves_malformed_escapes() {
    assert_eq!(percent_decode(b"a%5Fb%2"), b"a_b%2");
    assert_eq!(percent_decode(b"%zz+"), b"%zz+");
}
