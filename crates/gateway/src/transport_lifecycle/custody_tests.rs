//! LIFE-CUSTODY: AT-CUSTODY-HUMAN and AT-CUSTODY-SOURCE.

use opensesame_domain::transport::TransportError;

use crate::managed_certs_tls::{tls_identity_for, unseal_count, TransportPurpose};
use crate::transport_lifecycle::custody::{self, IdentityScope};
use crate::transport_lifecycle::issuance;
use crate::transport_lifecycle::test_support as support;

#[tokio::test]
async fn a_managed_listener_identity_resolves_to_a_tls_identity_and_not_to_pem() {
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let issued = issuance::issue_for_transport(
        &state,
        &organization,
        support::listener_request("host.test"),
        "operator",
    )
    .await
    .expect("issue");

    let identity = custody::resolve_managed_identity(
        &state,
        &issued.certificate_id,
        TransportPurpose::Listener,
    )
    .await
    .expect("resolve");
    assert_eq!(
        identity.leaf_thumbprint_sha256(),
        issued.leaf_thumbprint_sha256,
    );
    // The one thing this seam must never do.
    let debug = format!("{identity:?}");
    assert!(!debug.contains("PRIVATE KEY"), "{debug}");
    assert!(!debug.contains("BEGIN"), "{debug}");
}

#[tokio::test]
async fn another_tenants_certificate_is_refused_before_anything_is_unsealed() {
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let issued = issuance::issue_for_transport(
        &state,
        &organization,
        crate::transport_lifecycle::issuance::TransportIssuanceRequest {
            purpose: TransportPurpose::UpstreamConnector,
            selector: opensesame_domain::transport::PeerIdentitySelector::DnsName(
                "upstream.test".into(),
            ),
            validity_seconds: Some(7 * 24 * 3_600),
            renew_before_seconds: Some(3_600),
            managed: true,
        },
        "operator",
    )
    .await
    .expect("issue");

    let before = unseal_count();
    let foreign = IdentityScope {
        organization_id: support::other_org(),
        connection_id: "connection:1".into(),
        identity: issued.certificate_id.clone(),
        purpose: TransportPurpose::UpstreamConnector,
    };
    let error = custody::resolve_client_identity(&state, &foreign)
        .await
        .expect_err("a foreign certificate must be refused");
    assert_eq!(error, TransportError::PeerDisallowed);
    assert_eq!(
        unseal_count(),
        before,
        "the sealed key must not be opened for a tenant that does not own the row",
    );
}

#[tokio::test]
async fn a_purpose_the_certificate_was_not_issued_for_is_refused() {
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let issued = issuance::issue_for_transport(
        &state,
        &organization,
        support::listener_request("host.test"),
        "operator",
    )
    .await
    .expect("issue");

    let error = custody::resolve_managed_identity(
        &state,
        &issued.certificate_id,
        TransportPurpose::NatsClient,
    )
    .await
    .expect_err("a listener certificate is not a nats client identity");
    assert_eq!(error, TransportError::PeerDisallowed);
}

#[tokio::test]
async fn a_listener_purpose_is_never_reachable_through_the_connector_resolver() {
    let state = support::state_with_authority().await;
    let before = unseal_count();
    let scope = IdentityScope {
        organization_id: state.connection_organization,
        connection_id: "connection:1".into(),
        identity: "certificate:whatever".into(),
        purpose: TransportPurpose::Listener,
    };
    let error = custody::resolve_client_identity(&state, &scope)
        .await
        .expect_err("a connection may not select the host's own listener identity");
    assert_eq!(error, TransportError::PeerDisallowed);
    assert_eq!(unseal_count(), before);
}

#[tokio::test]
async fn an_unknown_certificate_id_names_nothing_and_reads_nothing() {
    let state = support::state_with_authority().await;
    let before = unseal_count();
    let error = custody::resolve_managed_identity(
        &state,
        "certificate:does-not-exist",
        TransportPurpose::Listener,
    )
    .await
    .expect_err("unknown id");
    assert_eq!(error, TransportError::IdentityMissing);
    assert_eq!(unseal_count(), before);
}

#[tokio::test]
async fn the_human_only_reveal_path_is_untouched_and_separate() {
    // AT-CUSTODY-HUMAN's other half: the use path never returns PEM, and the
    // reveal path — which does, on purpose, for a human — still works and is
    // a different function with a different gate.
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let issued = issuance::issue_for_transport(
        &state,
        &organization,
        support::listener_request("host.test"),
        "operator",
    )
    .await
    .expect("issue");

    let revealed = crate::managed_certs::reveal_managed_key(
        &state,
        &organization.to_string(),
        &issued.certificate_id,
    )
    .await
    .expect("human reveal");
    assert!(
        revealed.contains("PRIVATE KEY"),
        "the human path returns PEM"
    );

    // …and the TLS path, given the same row, returns an identity whose
    // rendered form holds none of those bytes.
    let identity = tls_identity_for(
        &state,
        &issued.certificate_id,
        TransportPurpose::Listener,
        Some(&organization),
    )
    .await
    .expect("tls identity");
    let rendered = format!("{identity:?}");
    for line in revealed.lines().filter(|line| !line.starts_with("---")) {
        assert!(
            !rendered.contains(line.trim()),
            "key bytes leaked: {rendered}"
        );
    }
}

#[tokio::test]
async fn a_revoked_leaf_is_never_served_from_the_identity_cache() {
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let issued = issuance::issue_for_transport(
        &state,
        &organization,
        support::listener_request("host.test"),
        "operator",
    )
    .await
    .expect("issue");
    let identity = custody::resolve_managed_identity(
        &state,
        &issued.certificate_id,
        TransportPurpose::Listener,
    )
    .await
    .expect("first resolve");
    state
        .transport_lifecycle
        .deny(&identity.leaf_thumbprint_sha256());
    let error = custody::resolve_managed_identity(
        &state,
        &issued.certificate_id,
        TransportPurpose::Listener,
    )
    .await
    .expect_err("a denied leaf must not come back out of the cache");
    assert_eq!(error, TransportError::EvidenceRevoked);
}
