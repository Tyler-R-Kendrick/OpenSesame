//! AT-OPENBAO-REAL / AT-OPENBAO-TOKEN: certificate authentication against a
//! real, TLS-enabled, client-certificate-requiring `OpenBao`.
//!
//! `#[ignore]` by default and additionally gated on `OPENSESAME_MTLS_FIXTURES=1`,
//! because it downloads nothing at test time but does need the pinned `bao`
//! binary `scripts/mtls/mtls-fixtures.sh` fetches:
//!
//! ```text
//! OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-provider-openbao -- --ignored
//! ```
//!
//! What it establishes, in order of how much it would hurt to be wrong about:
//!
//! 1. A good leaf against the role whose SAN constraint it satisfies gets a
//!    token, with that role's policies and its `lease_duration`.
//! 2. The **same** good leaf against a role constrained to a different SAN is
//!    refused. Authentication is not authorization: being trusted by the CA
//!    the role names is not enough.
//! 3. A leaf from a foreign root fails the handshake — the listener's
//!    `tls_client_ca_file` decides, and no request body is ever sent.
//! 4. No client certificate at all fails, at the listener, for the same
//!    reason. (`bao server -dev` is plaintext and proves none of this.)
//! 5. The issued token's policy scope is enforced by the server: it reads the
//!    path its policy allows and is refused the one it does not.
//! 6. Revoking the **certificate's** authorization stops new logins and leaves
//!    the already-issued token working. Only `revoke_token` kills the token.
//!    That split is the honest statement of ADR 0132's revocation boundary,
//!    and it is asserted rather than described.

mod support;

use opensesame_provider_openbao::cert_auth::{CertTokenScope, OpenBaoAuthMode, OpenBaoCertAuth};
use opensesame_provider_openbao::AuthorityError;
use secrecy::ExposeSecret;
use support::bao::{
    fixtures_enabled, LiveBao, ALLOWED_PATH, FORBIDDEN_PATH, POLICY_READ, ROLE_A, ROLE_B,
};

fn scope(bao: &LiveBao, role: &str) -> CertTokenScope {
    CertTokenScope {
        role: role.to_owned(),
        identity_thumbprint: bao.client_a.identity().leaf_thumbprint_sha256(),
        trust_generation: 1,
    }
}

fn adapter(bao: &LiveBao, role: &str) -> OpenBaoCertAuth {
    OpenBaoCertAuth::new(
        bao.base(),
        OpenBaoAuthMode::cert_role(role).expect("role"),
        scope(bao, role),
        bao.client(Some(&bao.client_a), &bao.ca),
    )
    .expect("adapter")
}

#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1 and the pinned bao binary"]
async fn a_real_openbao_authenticates_a_certificate_and_scopes_its_token() {
    if !fixtures_enabled() {
        eprintln!("OPENSESAME_MTLS_FIXTURES=1 is not set; skipping");
        return;
    }
    let bao = LiveBao::start().await;

    // 1. The right leaf for the right role.
    let token = adapter(&bao, ROLE_A).login().await.expect("role-a login");
    assert!(
        token.has_policy(POLICY_READ),
        "the token must carry exactly the role's policy: {token:?}"
    );
    assert!(!token.has_policy("root"));
    assert!(!token.has_policy("connector-admin"));
    assert!(token.lease_duration.as_secs() > 0, "the lease is real");
    assert!(token.is_usable_at(chrono::Utc::now()));

    // 2. The same leaf, a role whose SAN constraint it does not satisfy.
    let denied = adapter(&bao, ROLE_B)
        .login()
        .await
        .expect_err("role-b constrains a different SAN");
    assert!(
        matches!(denied, AuthorityError::Denied(_)),
        "a constraint mismatch is a refusal, not a transport fault: {denied:?}"
    );

    // 3. A leaf from a foreign root: the listener's client CA refuses it and
    //    the handshake dies before any request body is written.
    let stranger =
        bao.foreign_ca
            .issue_client(opensesame_domain::transport::PeerIdentitySelector::DnsName(
                "a.clients.example".into(),
            ));
    let foreign = OpenBaoCertAuth::new(
        bao.base(),
        OpenBaoAuthMode::cert_role(ROLE_A).expect("role"),
        scope(&bao, ROLE_A),
        bao.client(Some(&stranger), &bao.ca),
    )
    .expect("adapter");
    let error = foreign
        .login()
        .await
        .expect_err("a foreign root is not trusted");
    assert!(
        matches!(error, AuthorityError::Provider(_)),
        "a handshake failure is a transport fault, never a token: {error:?}"
    );

    // 4. No client certificate at all.
    let anonymous = OpenBaoCertAuth::new(
        bao.base(),
        OpenBaoAuthMode::cert_role(ROLE_A).expect("role"),
        scope(&bao, ROLE_A),
        bao.client(None, &bao.ca),
    )
    .expect("adapter");
    let error = anonymous
        .login()
        .await
        .expect_err("the listener requires a client certificate");
    assert!(matches!(error, AuthorityError::Provider(_)), "{error:?}");

    // 5. The token's scope is the server's to enforce, and it does.
    let raw = adapter(&bao, ROLE_A)
        .token()
        .await
        .expect("token")
        .expose_secret()
        .to_owned();
    assert_eq!(bao.read_with_token(&raw, ALLOWED_PATH).await, 200);
    assert_eq!(bao.read_with_token(&raw, FORBIDDEN_PATH).await, 403);
}

#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1 and the pinned bao binary"]
async fn revoking_the_certificate_does_not_revoke_the_token() {
    if !fixtures_enabled() {
        eprintln!("OPENSESAME_MTLS_FIXTURES=1 is not set; skipping");
        return;
    }
    let bao = LiveBao::start().await;
    let adapter = adapter(&bao, ROLE_A);

    let raw = adapter
        .token()
        .await
        .expect("token")
        .expose_secret()
        .to_owned();
    assert_eq!(bao.read_with_token(&raw, ALLOWED_PATH).await, 200);

    // Revoke the certificate's authorization: the role is gone, so the
    // certificate can no longer authenticate anything.
    bao.delete_role(ROLE_A).await;
    let error = adapter
        .login()
        .await
        .expect_err("a deleted role authenticates nobody");
    assert!(matches!(error, AuthorityError::Denied(_)), "{error:?}");

    // The already-issued token is untouched. This is the property callers get
    // wrong: a transport certificate and an OpenBao token have independent
    // lifetimes, and revoking one does not revoke the other.
    assert_eq!(
        bao.read_with_token(&raw, ALLOWED_PATH).await,
        200,
        "revoking the certificate must not be reported as revoking the token"
    );

    // Only an explicit token revocation ends it.
    adapter.revoke_token().await.expect("revoke-self");
    assert_eq!(
        bao.read_with_token(&raw, ALLOWED_PATH).await,
        403,
        "revoke_token is what actually invalidates the token"
    );
}
