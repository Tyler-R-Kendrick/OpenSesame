//! LIFE-ISSUANCE, including AT-CUSTODY-BOOTSTRAP's gateway half: issuing a
//! certificate creates no trust and no binding, so nothing an unprivileged
//! actor can upload becomes a service identity by itself.

use opensesame_domain::transport::PeerIdentitySelector;

use crate::managed_certs_tls::TransportPurpose;
use crate::transport_lifecycle::issuance::{
    self, IssuanceError, TransportIssuanceRequest, MAX_VALIDITY_SECONDS,
};
use crate::transport_lifecycle::minting::LeafShape;
use crate::transport_lifecycle::test_support as support;
use crate::transport_lifecycle::trust;

fn request(selector: PeerIdentitySelector) -> TransportIssuanceRequest {
    TransportIssuanceRequest {
        purpose: TransportPurpose::Listener,
        selector,
        validity_seconds: Some(7 * 24 * 3_600),
        renew_before_seconds: Some(3_600),
        managed: true,
    }
}

#[test]
fn only_an_exact_dns_name_or_spiffe_id_is_an_issuable_identity() {
    assert!(LeafShape::derive(
        TransportPurpose::Listener,
        PeerIdentitySelector::DnsName("host.test".into())
    )
    .is_ok());
    assert!(LeafShape::derive(
        TransportPurpose::WorkerClient,
        PeerIdentitySelector::SpiffeId("spiffe://example.test/worker".into())
    )
    .is_ok());
    for refused in [
        PeerIdentitySelector::DnsName("*.host.test".into()),
        PeerIdentitySelector::DnsName("10.0.0.1".into()),
        PeerIdentitySelector::UriSan("https://host.test/".into()),
        PeerIdentitySelector::LeafThumbprintSha256("ab".repeat(32)),
    ] {
        assert!(
            LeafShape::derive(TransportPurpose::Listener, refused.clone()).is_err(),
            "{refused:?} must not be issuable",
        );
    }
}

#[test]
fn a_client_purpose_never_gets_server_auth_and_a_listener_gets_both() {
    let client = LeafShape::derive(
        TransportPurpose::UpstreamConnector,
        PeerIdentitySelector::DnsName("upstream.test".into()),
    )
    .expect("shape");
    assert!(!client.server_auth);
    assert!(client.client_auth);

    let listener = LeafShape::derive(
        TransportPurpose::Listener,
        PeerIdentitySelector::DnsName("host.test".into()),
    )
    .expect("shape");
    assert!(listener.server_auth && listener.client_auth);

    // A SPIFFE X.509-SVID carries both EKUs whatever it is used for.
    let svid = LeafShape::derive(
        TransportPurpose::WorkerClient,
        PeerIdentitySelector::SpiffeId("spiffe://example.test/worker".into()),
    )
    .expect("shape");
    assert!(svid.server_auth && svid.client_auth);
}

#[test]
fn validity_beyond_the_ceiling_is_a_policy_violation_not_a_clamp() {
    let shape = LeafShape::derive(
        TransportPurpose::Listener,
        PeerIdentitySelector::DnsName("host.test".into()),
    )
    .expect("shape");
    assert!(shape.check_policy(MAX_VALIDITY_SECONDS).is_ok());
    let violations = shape
        .check_policy(MAX_VALIDITY_SECONDS + 1)
        .expect_err("over the ceiling");
    assert!(!violations.is_empty());
}

#[tokio::test]
async fn an_unmanaged_request_is_refused_because_its_key_would_have_nowhere_to_live() {
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let mut body = request(PeerIdentitySelector::DnsName("host.test".into()));
    body.managed = false;
    let error = issuance::issue_for_transport(&state, &organization, body, "operator")
        .await
        .expect_err("unmanaged");
    assert!(matches!(error, IssuanceError::NotManaged));
    assert_eq!(error.code(), "custody_required");
    assert_eq!(error.http_status(), 400);
}

#[tokio::test]
async fn a_refused_selector_mints_nothing_at_all() {
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let before = state
        .db
        .list_certificates(
            &organization.to_string(),
            &opensesame_storage::CertificateFilter::default(),
        )
        .await
        .map(|rows| rows.len())
        .unwrap_or_default();
    let error = issuance::issue_for_transport(
        &state,
        &organization,
        request(PeerIdentitySelector::DnsName("*.host.test".into())),
        "operator",
    )
    .await
    .expect_err("wildcard");
    assert_eq!(error.code(), "invalid_selector");
    let after = state
        .db
        .list_certificates(
            &organization.to_string(),
            &opensesame_storage::CertificateFilter::default(),
        )
        .await
        .map(|rows| rows.len())
        .unwrap_or_default();
    assert_eq!(before, after, "a refused request must not leave a row");
}

#[tokio::test]
async fn issuing_grants_no_trust_and_no_binding_of_its_own() {
    // AT-CUSTODY-BOOTSTRAP. Holding a certificate this host signed is not
    // authority: the trust profiles and the binding set are both untouched,
    // so nothing the issuance produced can be presented as a service peer
    // until an operator separately says so.
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let trust_before = trust::load(&state).await.expect("trust");
    let bindings_before = crate::transport::bindings::load(&state.db, None)
        .await
        .expect("bindings");

    let issued = issuance::issue_for_transport(
        &state,
        &organization,
        request(PeerIdentitySelector::DnsName("host.test".into())),
        "operator",
    )
    .await
    .expect("issue");
    assert!(issued.certificate_pem.contains("BEGIN CERTIFICATE"));
    assert!(!issued.certificate_pem.contains("PRIVATE KEY"));
    assert!(!issued.issuer_pem.contains("PRIVATE KEY"));

    let trust_after = trust::load(&state).await.expect("trust");
    let bindings_after = crate::transport::bindings::load(&state.db, None)
        .await
        .expect("bindings");
    assert_eq!(trust_before, trust_after, "issuance must not add an anchor");
    assert_eq!(
        bindings_before.set.revision, bindings_after.set.revision,
        "issuance must not add a binding",
    );
    assert!(bindings_after.set.bindings.is_empty());
}

#[tokio::test]
async fn the_renewal_lead_is_clamped_so_a_successor_is_not_immediately_due() {
    // ADR 0075's convergence bound, reached through transport issuance.
    let state = support::state_with_authority().await;
    let organization = state.connection_organization;
    let mut body = request(PeerIdentitySelector::DnsName("host.test".into()));
    body.validity_seconds = Some(2 * 24 * 3_600);
    body.renew_before_seconds = Some(10 * 24 * 3_600);
    let issued = issuance::issue_for_transport(&state, &organization, body, "operator")
        .await
        .expect("issue");
    let lead = issued.renew_before_seconds.expect("lead");
    assert!(
        lead <= 24 * 3_600,
        "lead {lead} must be at most half the lifetime",
    );
}
