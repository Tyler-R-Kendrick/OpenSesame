use super::*;
use serde_json::{from_str, from_value, json, to_value};

#[test]
fn enums_use_snake_case_wire_spellings() {
    assert_eq!(
        to_value(TransportPolicy::MtlsRequired).unwrap(),
        json!("mtls_required")
    );
    assert_eq!(
        to_value(TransportPolicy::ExistingLocal).unwrap(),
        json!("existing_local")
    );
    assert_eq!(to_value(TlsVersion::Tls13).unwrap(), json!("tls13"));
    assert_eq!(
        to_value(IdentitySourceKind::SpiffeWorkloadApi).unwrap(),
        json!("spiffe_workload_api")
    );
    assert_eq!(
        to_value(Custody::HostSealedExportableToHost).unwrap(),
        json!("host_sealed_exportable_to_host")
    );
    assert_eq!(
        to_value(TrustProfileKind::WebPkiDns).unwrap(),
        json!("web_pki_dns")
    );
    assert_eq!(
        to_value(EvidenceSource::TrustedIngressAssertion).unwrap(),
        json!("trusted_ingress_assertion")
    );
    assert_eq!(
        to_value(BindingPurpose::NatsAuthBridge).unwrap(),
        json!("nats_auth_bridge")
    );
}

#[test]
fn enums_reject_unknown_variants_and_coercion() {
    assert!(from_value::<TransportPolicy>(json!("auto")).is_err());
    assert!(from_value::<TransportPolicy>(json!("MtlsRequired")).is_err());
    assert!(from_value::<TransportPolicy>(json!(true)).is_err());
    assert!(from_value::<TransportPolicy>(json!(2)).is_err());
    assert!(from_value::<TlsVersion>(json!("tls11")).is_err());
    assert!(from_value::<TlsVersion>(json!("1.3")).is_err());
    assert!(from_value::<Custody>(json!("hardware_bound")).is_err());
    assert!(from_value::<EvidenceSource>(json!("header")).is_err());
}

#[test]
fn policy_never_downgrades_from_client_authentication() {
    assert_eq!(
        TransportPolicy::MtlsRequired.transition_to(TransportPolicy::ServerTls),
        Err(TransportError::PolicyDowngradeRefused)
    );
    assert_eq!(
        TransportPolicy::TrustedIngress.transition_to(TransportPolicy::ExistingLocal),
        Err(TransportError::PolicyDowngradeRefused)
    );
    assert_eq!(
        TransportPolicy::ServerTls.transition_to(TransportPolicy::MtlsRequired),
        Ok(TransportPolicy::MtlsRequired)
    );
    assert_eq!(
        TransportPolicy::MtlsRequired.transition_to(TransportPolicy::TrustedIngress),
        Ok(TransportPolicy::TrustedIngress)
    );
    assert!(!TransportPolicy::ServerTls.authenticates_client());
    assert!(TransportPolicy::MtlsRequired.authenticates_client());
}

#[test]
fn references_validate_on_construction_and_on_the_wire() {
    for good in ["a", "host-tls", "spire.prod_1", "0abc", &"x".repeat(64)] {
        assert!(TrustProfileRef::new(good).is_ok(), "{good}");
        assert!(IdentitySourceRef::new(good).is_ok(), "{good}");
    }
    for bad in [
        "",
        "-lead",
        ".lead",
        "Upper",
        "has space",
        "ünïcode",
        "a/b",
        &"x".repeat(65),
    ] {
        let err = TrustProfileRef::new(bad).unwrap_err();
        assert_eq!(err.code(), "malformed_configuration", "{bad}");
        assert!(
            from_value::<TrustProfileRef>(json!({ "name": bad })).is_err(),
            "{bad}"
        );
    }
    let wire: TrustProfileRef = from_str(r#"{"name":"private-root"}"#).unwrap();
    assert_eq!(wire.name, "private-root");
    assert_eq!(to_value(&wire).unwrap(), json!({ "name": "private-root" }));
    assert!(from_str::<TrustProfileRef>(r#"{"name":"x","path":"/etc/ca.pem"}"#).is_err());
    assert!(from_str::<IdentitySourceRef>(r#""plain-string""#).is_err());
    assert!(TrustProfileRef { name: "BAD".into() }.validate().is_err());
}

#[test]
fn error_codes_are_stable_snake_case_and_exhaustive() {
    let all = [
        TransportError::IdentityMissing,
        TransportError::KeyPairMismatch,
        TransportError::TrustUnknown,
        TransportError::PeerNotBound,
        TransportError::PeerDisallowed,
        TransportError::AmbiguousBinding,
        TransportError::EvidenceExpired,
        TransportError::EvidenceRevoked,
        TransportError::GenerationStale,
        TransportError::SourceUnsupported,
        TransportError::ForwardedEvidenceUnverified,
        TransportError::ProofMismatch,
        TransportError::ListenerPolicyMismatch,
        TransportError::BindingDisabled,
        TransportError::EnforcementUnsupported,
        TransportError::PolicyDowngradeRefused,
        TransportError::MalformedConfiguration("x".into()),
    ];
    let codes: Vec<&str> = all.iter().map(TransportError::code).collect();
    assert_eq!(codes, TransportError::ALL_CODES);
    for code in codes {
        assert!(
            code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'),
            "{code}"
        );
    }
    assert_eq!(TransportError::PeerNotBound.code(), "peer_not_bound");
    assert_eq!(
        TransportError::ForwardedEvidenceUnverified.code(),
        "forwarded_evidence_unverified"
    );
}

#[test]
fn error_view_carries_code_and_only_malformed_detail() {
    let view = TransportError::malformed("binding.id: empty id").view();
    assert_eq!(
        to_value(&view).unwrap(),
        json!({ "code": "malformed_configuration", "detail": "binding.id: empty id" })
    );
    let view = TransportError::EvidenceRevoked.view();
    assert_eq!(
        to_value(&view).unwrap(),
        json!({ "code": "evidence_revoked", "detail": null })
    );
    let parsed: TransportErrorView = from_str(r#"{"code":"peer_not_bound"}"#).unwrap();
    assert_eq!(parsed.detail, None);
    assert!(from_str::<TransportErrorView>(r#"{"code":"peer_not_bound","secret":"x"}"#).is_err());
    assert_eq!(
        to_value(TransportError::PeerNotBound).unwrap(),
        json!("peer_not_bound")
    );
}

#[test]
fn ids_are_printable_ascii_bounded() {
    assert!(validate_id("f", "svc-a").is_ok());
    assert!(validate_id("f", &"a".repeat(128)).is_ok());
    for bad in ["", " ", "a b", "tab\t", "ünï", "\u{200b}", &"a".repeat(129)] {
        assert_eq!(
            validate_id("f", bad).unwrap_err().code(),
            "malformed_configuration",
            "{bad:?}"
        );
    }
    assert!(validate_thumbprint("t", &"ab".repeat(32)).is_ok());
    for bad in [
        &"AB".repeat(32),
        &"ab".repeat(31),
        &"zz".repeat(32),
        &"ab".repeat(33),
    ] {
        assert!(validate_thumbprint("t", bad).is_err(), "{bad}");
    }
}

#[test]
fn operation_strings_are_the_contract_spellings() {
    assert_eq!(
        operations::KNOWN,
        &[
            "nats.callout.decide",
            "worker.providers.list",
            "worker.health.ready",
            "principals.mapping.resolve",
            "ingress.forward",
            "transport.probe",
            "connector.invoke",
        ]
    );
    for op in operations::KNOWN {
        assert!(validate_id("op", op).is_ok());
    }
}
