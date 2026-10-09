//! LIFE-REVOCATION: AT-TLS-REVOKEDLIVE with a real keep-alive client, the
//! per-layer bound the outcome states, and the CRL freshness reading.

use std::sync::Arc;

use chrono::{Duration, Utc};
use opensesame_transport_security::testkit::DisposableCa;

use crate::transport_lifecycle::crl::{crl_freshness, CrlFreshness};
use crate::transport_lifecycle::revocation::{self, RevokeReason, RevokeRequest};
use crate::transport_lifecycle::test_support as support;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_revoked_leaf_is_denied_on_an_already_authenticated_connection() {
    // AT-TLS-REVOKEDLIVE. The connection is established and used *before* the
    // revocation, and stays open across it. The TLS session is not torn down —
    // that is not something a server can promise — but the next protected
    // operation on it is refused, which is the bound we actually enforce.
    let state = support::state().await;
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let generations =
        support::generations(server_ca.issue_server("localhost").identity(), &client_ca);
    let listener = support::serve(
        Arc::clone(&generations),
        support::profile_fn(&state),
        support::router(Arc::clone(&generations)),
    )
    .await;
    state
        .transport_lifecycle
        .attach_generations(Arc::clone(&generations), std::collections::BTreeMap::new());

    let leaf = support::client_leaf(&client_ca, "worker.test");
    let config = support::client(&server_ca, Some(Arc::new(leaf.identity())));
    let mut live = support::connect(Arc::clone(&config), listener.addr)
        .await
        .expect("connect");
    assert_eq!(
        support::request_on(&mut live, "/protected")
            .await
            .expect("before revocation")
            .0,
        200,
    );

    let outcome = revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        RevokeRequest {
            certificate_id: None,
            thumbprint: Some(leaf.thumbprint.clone()),
            reason: RevokeReason::KeyCompromise,
        },
    )
    .await
    .expect("revoke");
    assert_eq!(outcome.leaf_thumbprint_sha256, leaf.thumbprint);

    // Layer 2: the open connection's next protected operation.
    let (status, _) = support::request_on(&mut live, "/protected")
        .await
        .expect("after revocation");
    assert_eq!(
        status, 403,
        "an open, already-authenticated connection must be denied its next protected operation",
    );

    // Layer 1: a brand-new handshake with the same leaf.
    let fresh = support::connect(config, listener.addr).await;
    match fresh {
        Err(message) => assert!(message.starts_with("tls:"), "{message}"),
        Ok(mut stream) => {
            // TLS 1.3 can complete the client's half before the server's
            // rejection arrives; the request then fails or is denied.
            if let Ok((status, _)) = support::request_on(&mut stream, "/protected").await {
                assert_eq!(status, 403);
            }
        }
    }
}

#[tokio::test]
async fn the_outcome_names_the_bound_for_every_layer_including_the_ones_it_cannot_reach() {
    // AT-OPENBAO-TOKEN: a transport revocation does not revoke an already
    // minted OpenBao/OAuth token, and the response says so rather than
    // implying fleet-wide invalidation.
    let state = support::state().await;
    let outcome = revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        RevokeRequest {
            certificate_id: None,
            thumbprint: Some("ab".repeat(32)),
            reason: RevokeReason::Superseded,
        },
    )
    .await
    .expect("revoke by thumbprint");
    assert_eq!(outcome.new_handshakes, "refused_in_this_process");
    assert_eq!(
        outcome.existing_connections,
        "denied_on_next_guarded_request"
    );
    assert_eq!(outcome.tokens, "not_revoked_by_this_operation");
    assert_eq!(outcome.offline, "unreachable");
    assert!(
        outcome.bindings.starts_with("unchanged") || outcome.bindings.starts_with("updated"),
        "{}",
        outcome.bindings,
    );
    let rendered = serde_json::to_string(&outcome).expect("serialize");
    assert!(!rendered.contains("PRIVATE KEY"), "{rendered}");
}

#[tokio::test]
async fn exactly_one_of_certificate_id_or_thumbprint_is_accepted() {
    let state = support::state().await;
    for (certificate_id, thumbprint) in [
        (None, None),
        (Some("certificate:1".to_owned()), Some("ab".repeat(32))),
    ] {
        let error = revocation::revoke_transport(
            &state,
            &state.connection_organization,
            revocation::Revoker::Operator,
            RevokeRequest {
                certificate_id,
                thumbprint,
                reason: RevokeReason::Unspecified,
            },
        )
        .await
        .expect_err("ambiguous");
        assert_eq!(error.code(), "invalid_request");
        assert_eq!(error.http_status(), 400);
    }
}

#[tokio::test]
async fn a_thumbprint_that_is_not_a_thumbprint_is_refused_rather_than_stored() {
    let state = support::state().await;
    let before = state.transport_lifecycle.denied_count();
    let error = revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        RevokeRequest {
            certificate_id: None,
            thumbprint: Some("not-hex".into()),
            reason: RevokeReason::Unspecified,
        },
    )
    .await
    .expect_err("malformed");
    assert_eq!(error.code(), "invalid_request");
    assert_eq!(state.transport_lifecycle.denied_count(), before);
}

#[tokio::test]
async fn revoking_a_managed_certificate_denies_it_and_records_the_fact() {
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let issued = crate::transport_lifecycle::issuance::issue_for_transport(
        &state,
        &organization,
        support::listener_request("host.test"),
        "operator",
    )
    .await
    .expect("issue");

    let outcome = revocation::revoke_transport(
        &state,
        &organization,
        revocation::Revoker::Tenant,
        RevokeRequest {
            certificate_id: Some(issued.certificate_id.clone()),
            thumbprint: None,
            reason: RevokeReason::KeyCompromise,
        },
    )
    .await
    .expect("revoke");
    assert_eq!(
        outcome.leaf_thumbprint_sha256,
        issued.leaf_thumbprint_sha256
    );
    assert!(state
        .transport_lifecycle
        .is_denied(&issued.leaf_thumbprint_sha256));
    let recorded = crate::transport_lifecycle::facts::load(&state, &issued.certificate_id)
        .await
        .expect("facts");
    assert!(recorded.latest("revoked").is_some());
}

#[test]
fn reason_codes_are_the_rfc_5280_numbers() {
    assert_eq!(RevokeReason::Unspecified.code(), 0);
    assert_eq!(RevokeReason::KeyCompromise.code(), 1);
    assert_eq!(RevokeReason::CaCompromise.code(), 2);
    assert_eq!(RevokeReason::Superseded.code(), 4);
    assert_eq!(RevokeReason::PrivilegeWithdrawn.code(), 9);
}

#[test]
fn a_crl_past_its_next_update_is_stale_and_one_without_a_next_update_never_was_fresh() {
    let now = Utc::now();
    let fresh = CrlFreshness {
        crls: 1,
        loaded_at: now,
        this_update: now - Duration::hours(1),
        crl_fresh_until: Some(now + Duration::hours(1)),
    };
    assert!(!fresh.is_stale(now));
    assert!(fresh.is_stale(now + Duration::hours(2)));

    let never = CrlFreshness {
        crl_fresh_until: None,
        ..fresh
    };
    assert!(
        never.is_stale(now),
        "a CRL with no nextUpdate is stale from the moment it is read",
    );
}

#[test]
fn a_real_crl_parses_to_its_own_window_and_a_non_crl_file_is_refused() {
    let ca = DisposableCa::new("revoking");
    let leaf = ca.issue_client(opensesame_domain::transport::PeerIdentitySelector::DnsName(
        "worker.test".into(),
    ));
    let pem = ca.crl_pem(&[&leaf]);
    let now = Utc::now();
    let freshness = crl_freshness(&pem, now).expect("crl");
    assert_eq!(freshness.crls, 1);
    assert!(
        freshness.crl_fresh_until.is_some(),
        "the testkit CRL carries a nextUpdate",
    );

    assert!(
        crl_freshness(b"-----BEGIN CERTIFICATE-----\n", now).is_err(),
        "a file with no CRL block is a configuration error, not an empty CRL",
    );
}
