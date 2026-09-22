//! Pure tests for the certificate-auth adapter: the name fence, the response
//! parser, the lease arithmetic, and the fact that no public surface returns
//! a token.

use super::*;

fn login_body(lease: u64, policies: &[&str]) -> Value {
    json!({
        "auth": {
            "client_token": "s.NEVER-LOGGED",
            "policies": policies,
            "lease_duration": lease,
            "renewable": true,
        }
    })
}

#[test]
fn a_role_is_a_name_and_never_a_path() {
    for bad in [
        "",
        " ",
        "../../sys/root",
        "cert/login",
        "Role",
        "role name",
        &"r".repeat(65),
    ] {
        assert!(
            OpenBaoAuthMode::cert_role(bad).is_err(),
            "{bad:?} must not be a role"
        );
    }
    let mode = OpenBaoAuthMode::cert_role("web").unwrap();
    assert_eq!(mode.login_path().as_deref(), Some("/v1/auth/cert/login"));
    let remounted = OpenBaoAuthMode::cert_role_on("web", "workload-cert").unwrap();
    assert_eq!(
        remounted.login_path().as_deref(),
        Some("/v1/auth/workload-cert/login")
    );
    // Token mode has no login path at all: it is a different, explicit mode.
    assert_eq!(OpenBaoAuthMode::Token.login_path(), None);
}

#[test]
fn a_login_response_is_read_strictly() {
    let token = parse_login(&login_body(3600, &["connector-read"])).unwrap();
    assert!(token.has_policy("connector-read"));
    assert!(!token.has_policy("root"));
    assert_eq!(token.lease_duration, Duration::from_secs(3600));
    assert!(token.renewable);
    // Debug is a lifecycle summary, never the token.
    assert!(!format!("{token:?}").contains("NEVER-LOGGED"));

    // `token_policies` wins where both spellings are present.
    let both = json!({"auth":{"client_token":"s.x","policies":["old"],
        "token_policies":["new"],"lease_duration":10}});
    assert!(parse_login(&both).unwrap().has_policy("new"));

    for refused in [
        json!({}),
        json!({"auth": {}}),
        json!({"auth": {"client_token": ""}}),
        json!({"auth": {"client_token": 7}}),
        json!({"auth": []}),
    ] {
        assert!(parse_login(&refused).is_err(), "{refused}");
    }
    // A role the presented certificate does not match comes back as `errors`.
    let denied =
        parse_login(&json!({"errors": ["invalid certificate or no client certificate supplied"]}))
            .expect_err("a refusal is not a token");
    assert!(matches!(denied, AuthorityError::Denied(_)));
    let bare = parse_login(&json!({"errors": []})).expect_err("still a refusal");
    assert!(matches!(bare, AuthorityError::Denied(_)));
}

#[test]
fn a_lease_bounds_the_cached_token() {
    let mut token = parse_login(&login_body(3600, &["connector-read"])).unwrap();
    let issued = token.issued_at;
    assert_eq!(
        token.expires_at(),
        Some(issued + chrono::Duration::hours(1))
    );
    assert!(token.is_usable_at(issued));
    // The headroom means a token is stale before it actually expires, so a
    // request is never made with one that dies mid-flight.
    assert!(!token.is_usable_at(issued + chrono::Duration::seconds(3559)));
    assert!(!token.is_usable_at(issued + chrono::Duration::hours(2)));

    // A token with no lease (root/periodic) is not treated as expired, but it
    // is still scoped to this identity and still explicitly revocable.
    token.lease_duration = Duration::from_secs(0);
    assert_eq!(token.expires_at(), None);
    assert!(token.is_usable_at(issued + chrono::Duration::days(365)));
}

#[test]
fn the_cache_scope_separates_identities() {
    // CONN-TOKEN-LIFECYCLE: no global refreshed token shared across
    // certificate identities. Role, leaf and trust generation all separate.
    let base = CertTokenScope {
        role: "web".into(),
        identity_thumbprint: "a".repeat(64),
        trust_generation: 1,
    };
    for other in [
        CertTokenScope {
            role: "admin".into(),
            ..base.clone()
        },
        CertTokenScope {
            identity_thumbprint: "b".repeat(64),
            ..base.clone()
        },
        CertTokenScope {
            trust_generation: 2,
            ..base.clone()
        },
    ] {
        assert_ne!(other, base);
    }
}

#[test]
fn only_an_explicit_cert_role_builds_this_adapter() {
    let scope = CertTokenScope {
        role: "web".into(),
        identity_thumbprint: "a".repeat(64),
        trust_generation: 1,
    };
    let http = reqwest::Client::new();
    // Token mode is a different adapter; it is never reached by degrading.
    assert!(OpenBaoCertAuth::new(
        "https://bao.example",
        OpenBaoAuthMode::Token,
        scope.clone(),
        http.clone()
    )
    .is_err());
    // A cleartext remote base is refused before anything is sent.
    assert!(OpenBaoCertAuth::new(
        "http://bao.example",
        OpenBaoAuthMode::cert_role("web").unwrap(),
        scope.clone(),
        http.clone()
    )
    .is_err());
    let adapter = OpenBaoCertAuth::new(
        "https://bao.example/",
        OpenBaoAuthMode::cert_role("web").unwrap(),
        scope.clone(),
        http,
    )
    .unwrap();
    assert_eq!(adapter.scope(), &scope);
    assert!(!format!("{adapter:?}").contains("client_token"));
}

#[test]
fn no_public_method_returns_openbao_credential_material() {
    // The one accessor that yields the token is `pub(crate)`, and `token()`
    // hands back a `SecretString` that zeroizes. Read the source to be sure a
    // future edit does not quietly widen it (AT-CUSTODY-SOURCE's spirit for
    // this adapter; the MCP schema parity test lives in the surfaces).
    let src = include_str!("cert_auth.rs");
    let production = src.split("#[cfg(test)]").next().unwrap();
    assert!(production.contains("pub(crate) fn secret(&self)"));
    assert!(!production.contains("pub fn secret(&self)"));
    // The URL guard runs before every send.
    for method in ["pub async fn login", "pub async fn revoke_token"] {
        let body = production.split(method).nth(1).expect(method);
        let guard = body
            .find("assert_authority_base_url(&self.base)")
            .unwrap_or_else(|| panic!("{method} must re-check its base URL"));
        let send = body
            .find(".send()")
            .unwrap_or_else(|| panic!("{method} sends"));
        assert!(
            guard < send,
            "{method}: the URL guard must precede the send"
        );
    }
}
