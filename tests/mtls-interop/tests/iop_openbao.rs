//! IOP-OPENBAO — a real, TLS-enabled OpenBao with certificate auth, driven
//! by `curl`.
//!
//! SW-CONNECTOR already proved its own client against a live `bao` 2.3.2
//! (`crates/provider-openbao/tests/openbao_cert_auth_live.rs`): good role,
//! wrong role, foreign root, no certificate, policy scope, and certificate
//! revocation versus token revocation. This suite does not repeat that. It
//! adds what a first-party client cannot show:
//!
//! * the transport is *really* mutual TLS — a plaintext request to the same
//!   port fails, so no result here can be a dev-mode result;
//! * an entirely independent client (`curl` + OpenSSL, with certificates the
//!   system `openssl` minted) reaches the same conclusions;
//! * **cached-token isolation between tenants**: a token minted on tenant
//!   A's certificate is refused on tenant B's data even when it is presented
//!   over tenant B's own mutually-authenticated connection, and the reverse.
//!   Neither factor rescues the other — that is the credential-substitution
//!   threat the charter names.
//!
//! Everything lives in a temporary directory that is removed on drop, on a
//! kernel-chosen loopback port.

#[path = "support/bao.rs"]
mod bao;

use anyhow::Result;
use opensesame_mtls_interop::{fixtures_enabled, record};
use serde_json::json;

const TENANT_A_PATH: &str = "/v1/connector/data/tenant-a/secret";
const TENANT_B_PATH: &str = "/v1/connector/data/tenant-b/secret";

#[test]
#[ignore = "real OpenBao; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
fn a_real_tls_openbao_keeps_two_tenants_certificate_and_token_scoped() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let bao = bao::Bao::start()?;

    // 0. This is not a dev-mode server. A plaintext request to the same
    //    port gets no API answer: `bao server -dev` would return `200` with
    //    real health JSON here, and every result below would be worthless.
    let (_exit, status, body) = bao.plaintext_probe()?;
    assert_ne!(status, 200, "plaintext must not reach the API: {body}");
    assert!(
        !body.contains("\"sealed\""),
        "a plaintext answer carrying health JSON means this is a dev-mode server: {body}"
    );
    // And a client with no certificate cannot even open a session.
    let anonymous = bao.request("GET", "/v1/sys/health", None, &bao.ca.cert, None, None)?;
    assert!(
        anonymous.is_transport_failure(),
        "tls_require_and_verify_client_cert must refuse an anonymous client, got {} {}",
        anonymous.status,
        anonymous.body
    );

    // 1. Real login, each tenant on its own certificate and role.
    let login_a = bao.login(Some(&bao.tenant_a), &bao.ca.cert, "tenant-a")?;
    assert_eq!(login_a.status, 200, "tenant A login: {}", login_a.body);
    let token_a = login_a.body["auth"]["client_token"]
        .as_str()
        .expect("tenant A token")
        .to_owned();
    assert_eq!(
        login_a.body["auth"]["token_policies"],
        json!(["default", "tenant-a-read"]),
        "the token must carry exactly the role's policy"
    );

    let login_b = bao.login(Some(&bao.tenant_b), &bao.ca.cert, "tenant-b")?;
    assert_eq!(login_b.status, 200, "tenant B login: {}", login_b.body);
    let token_b = login_b.body["auth"]["client_token"]
        .as_str()
        .expect("tenant B token")
        .to_owned();

    // 2. Allowed invocation: each token reads its own tenant's path.
    let own_a = bao.request(
        "GET",
        TENANT_A_PATH,
        Some(&bao.tenant_a),
        &bao.ca.cert,
        Some(&token_a),
        None,
    )?;
    assert_eq!(own_a.status, 200, "{}", own_a.body);
    assert_eq!(own_a.body["data"]["data"]["value"], json!("tenant-a-only"));

    let own_b = bao.request(
        "GET",
        TENANT_B_PATH,
        Some(&bao.tenant_b),
        &bao.ca.cert,
        Some(&token_b),
        None,
    )?;
    assert_eq!(own_b.status, 200, "{}", own_b.body);

    // 3. Cached-token isolation. A token is not made valid for another
    //    tenant by being presented over that tenant's authenticated
    //    connection, and a certificate is not made sufficient by an
    //    accompanying token from elsewhere. Both crossings are refused, and
    //    the secret does not appear in either answer.
    let a_token_on_b_connection = bao.request(
        "GET",
        TENANT_B_PATH,
        Some(&bao.tenant_b),
        &bao.ca.cert,
        Some(&token_a),
        None,
    )?;
    assert_eq!(
        a_token_on_b_connection.status, 403,
        "tenant A's token must not read tenant B's data: {}",
        a_token_on_b_connection.body
    );
    assert!(
        !a_token_on_b_connection
            .body
            .to_string()
            .contains("tenant-b-only"),
        "the refusal must not leak the value"
    );

    let b_token_on_a_connection = bao.request(
        "GET",
        TENANT_A_PATH,
        Some(&bao.tenant_a),
        &bao.ca.cert,
        Some(&token_b),
        None,
    )?;
    assert_eq!(b_token_on_a_connection.status, 403);
    assert!(!b_token_on_a_connection
        .body
        .to_string()
        .contains("tenant-a-only"));

    // 4. Wrong role for the presented certificate: tenant A's certificate
    //    asking for tenant B's role. The chain is fine; the SAN constraint
    //    is not, so the *login* is refused rather than a token issued.
    let wrong_role = bao.login(Some(&bao.tenant_a), &bao.ca.cert, "tenant-b")?;
    assert_eq!(
        wrong_role.status, 400,
        "a certificate may only take the role bound to it: {}",
        wrong_role.body
    );
    assert!(wrong_role.body["auth"].is_null());

    // 5. Wrong certificate: the same DNS SAN from an unrelated root. This
    //    fails at TLS, before any role is considered.
    let impostor = bao.login(Some(&bao.impostor), &bao.ca.cert, "tenant-a")?;
    assert!(
        impostor.is_transport_failure(),
        "a foreign root must be refused by the listener, got {} {}",
        impostor.status,
        impostor.body
    );

    record(
        "IOP-OPENBAO-TENANTS",
        &format!("openbao {} (tls_require_and_verify_client_cert) <- curl/openssl", bao.version),
        "plaintext refused; two logins; own reads 200; both cross-tenant tokens 403; wrong role 400; foreign root refused at TLS",
    );
    Ok(())
}

/// Certificate revocation and token revocation are different events with
/// different blast radii, observed from an independent client.
#[test]
#[ignore = "real OpenBao; set OPENSESAME_MTLS_FIXTURES=1 and run with --ignored"]
fn revoking_the_certificate_role_and_revoking_the_token_are_different_events() -> Result<()> {
    if !fixtures_enabled() {
        eprintln!("skipped: set OPENSESAME_MTLS_FIXTURES=1");
        return Ok(());
    }
    let bao = bao::Bao::start()?;
    let login = bao.login(Some(&bao.tenant_a), &bao.ca.cert, "tenant-a")?;
    assert_eq!(login.status, 200, "{}", login.body);
    let token = login.body["auth"]["client_token"]
        .as_str()
        .expect("token")
        .to_owned();

    let read = |token: &str| {
        bao.request(
            "GET",
            TENANT_A_PATH,
            Some(&bao.tenant_a),
            &bao.ca.cert,
            Some(token),
            None,
        )
    };
    assert_eq!(read(&token)?.status, 200);

    // Deleting the certificate role stops new logins immediately...
    bao.admin("DELETE", "/v1/auth/cert/certs/tenant-a", None)?;
    let relogin = bao.login(Some(&bao.tenant_a), &bao.ca.cert, "tenant-a")?;
    assert_ne!(
        relogin.status, 200,
        "no new login may succeed once the role is gone: {}",
        relogin.body
    );

    // ...and does NOT invalidate the token already issued. This is the
    // honest limitation the charter insists on recording: revoking an
    // identity's authorization to *obtain* credentials is not revoking the
    // credentials it already holds.
    assert_eq!(
        read(&token)?.status,
        200,
        "the already-issued token still works; certificate revocation is not token revocation"
    );

    // Revoking the token is what ends it.
    let revoked = bao.request(
        "POST",
        "/v1/auth/token/revoke-self",
        Some(&bao.tenant_a),
        &bao.ca.cert,
        Some(&token),
        None,
    )?;
    assert!(
        (200..300).contains(&revoked.status),
        "revoke-self: {} {}",
        revoked.status,
        revoked.body
    );
    assert_eq!(
        read(&token)?.status,
        403,
        "after revocation the token must be refused"
    );

    record(
        "IOP-OPENBAO-REVOCATION",
        &format!("openbao {} <- curl/openssl", bao.version),
        "role delete: new login refused, existing token still 200; revoke-self: 403",
    );
    Ok(())
}
