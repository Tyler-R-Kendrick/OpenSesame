use super::attest::AttestedPeer;
use super::binding_tests::{at, binding, now, profile, set, spiffe, Mutation, HEX_A, HEX_B};
use super::*;
use serde_json::{from_value, json, to_value};

pub(super) fn attested(source: EvidenceSource, policy: TransportPolicy) -> AttestedPeer {
    AttestedPeer {
        source,
        identities: vec![spiffe("ns/prod/sa/nats-bridge")],
        leaf_thumbprint_sha256: HEX_A.into(),
        not_before: at("2026-09-22T00:00:00Z"),
        not_after: at("2026-09-23T00:00:00Z"),
        trust_profile: profile(),
        trust_generation: 3,
        credential_generation: 7,
        listener: "host-tls".into(),
        policy,
        tls_version: TlsVersion::Tls13,
        authenticated_at: at("2026-09-22T09:59:00Z"),
        usable_until: at("2026-09-22T10:29:00Z"),
        ingress: None,
    }
}

fn verified() -> VerifiedPeer {
    attested(EvidenceSource::DirectTls, TransportPolicy::MtlsRequired)
        .into_verified()
        .unwrap()
}

#[test]
fn into_verified_appends_the_thumbprint_and_exposes_every_fact() {
    let peer = verified();
    assert_eq!(peer.source(), EvidenceSource::DirectTls);
    assert_eq!(peer.identities().len(), 2);
    assert!(peer
        .identities()
        .contains(&PeerIdentitySelector::LeafThumbprintSha256(HEX_A.into())));
    assert_eq!(peer.leaf_thumbprint_sha256(), HEX_A);
    assert_eq!(peer.trust_profile(), &profile());
    assert_eq!(
        (peer.trust_generation(), peer.credential_generation()),
        (3, 7)
    );
    assert_eq!(peer.listener(), "host-tls");
    assert_eq!(peer.policy(), TransportPolicy::MtlsRequired);
    assert_eq!(peer.tls_version(), TlsVersion::Tls13);
    assert!(peer.ingress().is_none());
    assert!(peer.is_usable_at(now()));
    assert!(!peer.is_usable_at(at("2026-09-22T10:29:00Z")));
    assert!(!peer.is_usable_at(at("2026-09-22T09:58:59Z")));
    let view = peer.view();
    assert_eq!(view.leaf_thumbprint_sha256, HEX_A);
    assert_eq!(view.identities, peer.identities());
    let wire = to_value(&view).unwrap();
    assert_eq!(wire["source"], json!("direct_tls"));
    assert_eq!(wire["authenticated_at"], json!("2026-09-22T09:59:00.000Z"));
    assert!(wire.get("subject").is_none());
    let back: PeerEvidenceView = from_value(wire).unwrap();
    assert_eq!(back, view);
}

#[test]
fn into_verified_refuses_bad_facts() {
    let cases: Vec<(&str, Mutation<AttestedPeer>, &str)> = vec![
        (
            "bad thumbprint",
            Box::new(|a| a.leaf_thumbprint_sha256 = HEX_A.to_ascii_uppercase()),
            "malformed_configuration",
        ),
        (
            "thumbprint selector disagrees",
            Box::new(|a| {
                a.identities
                    .push(PeerIdentitySelector::LeafThumbprintSha256(HEX_B.into()));
            }),
            "malformed_configuration",
        ),
        (
            "malformed selector",
            Box::new(|a| a.identities = vec![PeerIdentitySelector::DnsName("*.x".into())]),
            "malformed_configuration",
        ),
        (
            "duplicate selector",
            Box::new(|a| a.identities = vec![spiffe("a"), spiffe("a")]),
            "malformed_configuration",
        ),
        (
            "empty listener",
            Box::new(|a| a.listener = String::new()),
            "malformed_configuration",
        ),
        (
            "bad profile",
            Box::new(|a| a.trust_profile = TrustProfileRef { name: "X".into() }),
            "malformed_configuration",
        ),
        (
            "inverted window",
            Box::new(|a| a.not_before = a.not_after),
            "malformed_configuration",
        ),
        (
            "authenticated before cert",
            Box::new(|a| a.authenticated_at = at("2026-09-21T23:59:59Z")),
            "evidence_expired",
        ),
        (
            "authenticated after cert",
            Box::new(|a| a.authenticated_at = a.not_after),
            "evidence_expired",
        ),
        (
            "usable past cert",
            Box::new(|a| a.usable_until = at("2026-09-23T00:00:01Z")),
            "evidence_expired",
        ),
        (
            "usable before authenticated",
            Box::new(|a| a.usable_until = at("2026-09-22T09:58:00Z")),
            "evidence_expired",
        ),
        (
            "direct tls on server_tls listener",
            Box::new(|a| a.policy = TransportPolicy::ServerTls),
            "listener_policy_mismatch",
        ),
        (
            "direct tls on local listener",
            Box::new(|a| a.policy = TransportPolicy::ExistingLocal),
            "listener_policy_mismatch",
        ),
        (
            "local ipc on tls listener",
            Box::new(|a| a.source = EvidenceSource::LocalIpc),
            "listener_policy_mismatch",
        ),
        (
            "assertion on mtls listener",
            Box::new(|a| a.source = EvidenceSource::TrustedIngressAssertion),
            "listener_policy_mismatch",
        ),
        (
            "ingress on a direct peer",
            Box::new(|a| {
                a.ingress = Some(Box::new(attested(
                    EvidenceSource::DirectTls,
                    TransportPolicy::TrustedIngress,
                )));
            }),
            "forwarded_evidence_unverified",
        ),
    ];
    for (why, mutate, code) in cases {
        let mut a = attested(EvidenceSource::DirectTls, TransportPolicy::MtlsRequired);
        mutate(&mut a);
        assert_eq!(a.into_verified().unwrap_err().code(), code, "{why}");
    }
    assert!(
        attested(EvidenceSource::LocalIpc, TransportPolicy::ExistingLocal)
            .into_verified()
            .is_ok()
    );
}

fn asserted() -> AttestedPeer {
    let mut ingress = attested(EvidenceSource::DirectTls, TransportPolicy::TrustedIngress);
    ingress.identities = vec![spiffe("ns/edge/sa/proxy")];
    ingress.leaf_thumbprint_sha256 = HEX_B.into();
    let mut client = attested(
        EvidenceSource::TrustedIngressAssertion,
        TransportPolicy::TrustedIngress,
    );
    client.identities = vec![PeerIdentitySelector::DnsName("client.example".into())];
    client.ingress = Some(Box::new(ingress));
    client
}

#[test]
fn forwarded_evidence_needs_an_authenticated_ingress() {
    let peer = asserted().into_verified().unwrap();
    assert_eq!(peer.source(), EvidenceSource::TrustedIngressAssertion);
    let ingress = peer.ingress().unwrap();
    assert_eq!(ingress.leaf_thumbprint_sha256(), HEX_B);
    assert_eq!(peer.view().ingress.unwrap().leaf_thumbprint_sha256, HEX_B);

    let mut no_ingress = asserted();
    no_ingress.ingress = None;
    assert_eq!(
        no_ingress.into_verified().unwrap_err().code(),
        "forwarded_evidence_unverified"
    );

    let mut ingress_is_assertion = asserted();
    ingress_is_assertion.ingress = Some(Box::new(asserted()));
    assert_eq!(
        ingress_is_assertion.into_verified().unwrap_err().code(),
        "forwarded_evidence_unverified"
    );

    let mut ingress_on_wrong_listener = asserted();
    ingress_on_wrong_listener.ingress.as_mut().unwrap().policy = TransportPolicy::MtlsRequired;
    assert_eq!(
        ingress_on_wrong_listener
            .into_verified()
            .unwrap_err()
            .code(),
        "forwarded_evidence_unverified"
    );

    let mut ingress_bad = asserted();
    ingress_bad.ingress.as_mut().unwrap().leaf_thumbprint_sha256 = "nope".into();
    assert_eq!(
        ingress_bad.into_verified().unwrap_err().code(),
        "malformed_configuration"
    );
}

fn bindings() -> ServiceBindingSet {
    set(vec![binding(
        "bridge",
        spiffe("ns/prod/sa/nats-bridge"),
        BindingPurpose::NatsAuthBridge,
    )])
}

fn admit(
    peer: VerifiedPeer,
    purpose: BindingPurpose,
    trust: u64,
    cred: u64,
) -> Result<ServiceCaller, &'static str> {
    ServiceCaller::admit(
        peer,
        &BindingScope::Deployment,
        &bindings(),
        purpose,
        trust,
        cred,
        now(),
    )
    .map_err(|e| e.code())
}

#[test]
fn admission_intersects_evidence_binding_and_operation() {
    let caller = admit(verified(), BindingPurpose::NatsAuthBridge, 3, 7).unwrap();
    assert_eq!(caller.binding.id, "bridge");
    assert!(caller.originating.is_none());
    assert!(caller
        .require_operation(operations::NATS_CALLOUT_DECIDE)
        .is_ok());
    assert_eq!(
        caller
            .require_operation(operations::WORKER_PROVIDERS_LIST)
            .unwrap_err()
            .code(),
        "peer_disallowed"
    );
    assert!(caller.require_audience("host").is_ok());
    assert_eq!(
        caller.require_audience("identity").unwrap_err().code(),
        "peer_disallowed"
    );
    // AT-TLS-WRONGSERVICE: authenticated, but not for this purpose.
    assert_eq!(
        admit(verified(), BindingPurpose::WorkerClient, 3, 7),
        Err("peer_not_bound")
    );
    // AT-EVIDENCE-STALE at the admission boundary.
    assert_eq!(
        admit(verified(), BindingPurpose::NatsAuthBridge, 4, 7),
        Err("generation_stale")
    );
    assert_eq!(
        admit(verified(), BindingPurpose::NatsAuthBridge, 3, 8),
        Err("generation_stale")
    );
    // Past usable_until, over an open connection.
    let late = ServiceCaller::admit(
        verified(),
        &BindingScope::Deployment,
        &bindings(),
        BindingPurpose::NatsAuthBridge,
        3,
        7,
        at("2026-09-22T10:29:00Z"),
    );
    assert_eq!(late.unwrap_err().code(), "evidence_expired");
    // Revoked leaf under the name binding.
    let mut revoked = bindings();
    revoked.bindings[0].denied_thumbprints = vec![HEX_A.into()];
    let err = ServiceCaller::admit(
        verified(),
        &BindingScope::Deployment,
        &revoked,
        BindingPurpose::NatsAuthBridge,
        3,
        7,
        now(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "evidence_revoked");
}

#[test]
fn admission_of_forwarded_evidence_binds_the_ingress_and_keeps_the_client_request_local() {
    let mut set = bindings();
    let mut ingress_binding = binding(
        "edge",
        spiffe("ns/edge/sa/proxy"),
        BindingPurpose::TrustedIngress,
    );
    ingress_binding.allowed_operations = vec![operations::INGRESS_FORWARD.into()];
    set.bindings.push(ingress_binding);
    let peer = asserted().into_verified().unwrap();
    let caller = ServiceCaller::admit(
        peer,
        &BindingScope::Deployment,
        &set,
        BindingPurpose::TrustedIngress,
        3,
        7,
        now(),
    )
    .unwrap();
    assert_eq!(caller.binding.id, "edge");
    assert_eq!(caller.peer.leaf_thumbprint_sha256(), HEX_B);
    let originating = caller.originating.as_ref().unwrap();
    assert_eq!(originating.leaf_thumbprint_sha256(), HEX_A);
    assert!(originating
        .identities()
        .contains(&PeerIdentitySelector::DnsName("client.example".into())));
    // The originating client's own name never resolves a binding by itself.
    let peer = asserted().into_verified().unwrap();
    let mut client_bound = bindings();
    client_bound.bindings.push(binding(
        "client",
        PeerIdentitySelector::DnsName("client.example".into()),
        BindingPurpose::TrustedIngress,
    ));
    let err = ServiceCaller::admit(
        peer,
        &BindingScope::Deployment,
        &client_bound,
        BindingPurpose::TrustedIngress,
        3,
        7,
        now(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "peer_not_bound");
}

#[test]
fn a_view_never_becomes_evidence() {
    // AT-TLS-FAKECONTEXT: the richest public DTO carries every field a
    // VerifiedPeer has, yet nothing consumes it as one. The source-contract
    // test proves no Deserialize exists; this proves the view stays a view.
    let wire = json!({
        "source": "direct_tls",
        "identities": [{ "spiffe_id": "spiffe://example.org/ns/prod/sa/nats-bridge" }],
        "leaf_thumbprint_sha256": HEX_A,
        "not_before": "2026-09-22T00:00:00.000Z", "not_after": "2026-09-23T00:00:00.000Z",
        "trust_profile": { "name": "private-root" }, "trust_generation": 3, "credential_generation": 7,
        "listener": "host-tls", "policy": "mtls_required", "tls_version": "tls13",
        "authenticated_at": "2026-09-22T09:59:00.000Z", "usable_until": "2026-09-22T10:29:00.000Z",
        "verified": true
    });
    assert!(
        from_value::<PeerEvidenceView>(wire.clone()).is_err(),
        "unknown field `verified` is refused"
    );
    let mut honest = wire;
    honest.as_object_mut().unwrap().remove("verified");
    let view: PeerEvidenceView = from_value(honest).unwrap();
    assert_eq!(view.source, EvidenceSource::DirectTls);
}
