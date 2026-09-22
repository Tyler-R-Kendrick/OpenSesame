use super::binding_tests::{at, now, HEX_A};
use super::evidence_tests::attested;
use super::*;
use serde_json::{from_value, json, to_value};

fn verified_enforcement() -> EnforcementStatus {
    EnforcementStatus::Verified {
        at: at("2026-09-22T09:00:00Z"),
        target: "host-tls".into(),
        generation: 3,
        accepted_with_certificate: true,
        rejected_without_certificate: true,
        fresh_until: at("2026-09-22T11:00:00Z"),
    }
}

fn view() -> TransportStatusView {
    TransportStatusView {
        target: "host-tls".into(),
        desired: TransportPolicy::MtlsRequired,
        credential: CredentialStatus::Configured {
            custody: Custody::NativeFileExportable,
            generation: 3,
            not_after: at("2026-12-01T00:00:00Z"),
            kind: IdentitySourceKind::PemFiles,
        },
        runtime: RuntimeStatus::Loaded {
            generation: 3,
            loaded_at: at("2026-09-22T08:00:00Z"),
        },
        observed: Some(ObservedAuthentication {
            at: at("2026-09-22T09:59:00Z"),
            observer: "host-tls-listener".into(),
            target: "host-tls".into(),
            generation: 3,
            peer: attested(EvidenceSource::DirectTls, TransportPolicy::MtlsRequired)
                .into_verified()
                .unwrap()
                .view(),
        }),
        enforcement: verified_enforcement(),
        capabilities: TransportCapabilities::native(
            CapabilityOutcome::Supported,
            CapabilityOutcome::unsupported("n/a"),
            CapabilityOutcome::unsupported("n/a"),
            true,
            true,
        ),
    }
}

#[test]
fn a_generation_change_makes_old_evidence_stale_not_certifying() {
    // AT-EVIDENCE-STALE
    let stale = verified_enforcement().reconcile(4, now());
    assert_eq!(
        stale,
        EnforcementStatus::Stale {
            verified_at: at("2026-09-22T09:00:00Z"),
            generation: 3,
            current_generation: 4
        }
    );
    assert!(!stale.enforces());
    assert!(verified_enforcement().reconcile(3, now()).enforces());
    // Freshness also expires.
    assert!(matches!(
        verified_enforcement().reconcile(3, at("2026-09-22T11:00:00Z")),
        EnforcementStatus::Stale { .. }
    ));
    assert_eq!(
        EnforcementStatus::Unverified.reconcile(9, now()),
        EnforcementStatus::Unverified
    );
    // Through the view: a reload to generation 4 (or no runtime at all).
    let mut v = view();
    v.runtime = RuntimeStatus::Loaded {
        generation: 4,
        loaded_at: now(),
    };
    assert!(matches!(
        v.reconciled(now()).enforcement,
        EnforcementStatus::Stale {
            current_generation: 4,
            ..
        }
    ));
    let mut v = view();
    v.runtime = RuntimeStatus::NotLoaded;
    assert!(matches!(
        v.reconciled(now()).enforcement,
        EnforcementStatus::Stale {
            current_generation: 0,
            ..
        }
    ));
    let mut v = view();
    v.runtime = RuntimeStatus::ReloadFailed {
        generation: 3,
        code: "key_pair_mismatch".into(),
    };
    assert!(v.clone().validate().is_ok());
    assert!(
        v.reconciled(now()).enforcement.enforces(),
        "a failed reload keeps serving generation 3"
    );
}

#[test]
fn accepting_a_certificate_is_not_enforcing_one() {
    // AT-EVIDENCE-POSITIVE, at the type level.
    let EnforcementStatus::Verified {
        at,
        target,
        generation,
        fresh_until,
        ..
    } = verified_enforcement()
    else {
        unreachable!()
    };
    let positive_only = EnforcementStatus::Verified {
        at,
        target,
        generation,
        accepted_with_certificate: true,
        rejected_without_certificate: false,
        fresh_until,
    };
    assert!(!positive_only.enforces());
    assert!(!EnforcementStatus::Unverified.enforces());
}

#[test]
fn views_round_trip_with_snake_case_and_refuse_coercion() {
    let wire = to_value(view()).unwrap();
    assert_eq!(wire["desired"], json!("mtls_required"));
    assert_eq!(
        wire["credential"]["configured"]["custody"],
        json!("native_file_exportable")
    );
    assert_eq!(
        wire["credential"]["configured"]["not_after"],
        json!("2026-12-01T00:00:00.000Z")
    );
    assert_eq!(wire["runtime"]["loaded"]["generation"], json!(3));
    assert_eq!(
        wire["enforcement"]["verified"]["rejected_without_certificate"],
        json!(true)
    );
    let back: TransportStatusView = from_value(wire.clone()).unwrap();
    assert_eq!(back, view());
    assert!(back.validate().is_ok());

    let mut coerced = wire.clone();
    coerced["enforcement"]["verified"]["rejected_without_certificate"] = json!("yes");
    assert!(from_value::<TransportStatusView>(coerced).is_err());
    let mut unknown = wire.clone();
    unknown["healthy"] = json!(true);
    assert!(from_value::<TransportStatusView>(unknown).is_err());
    let mut bad_time = wire.clone();
    bad_time["runtime"]["loaded"]["loaded_at"] = json!("2026-09-22 08:00:00");
    assert!(from_value::<TransportStatusView>(bad_time).is_err());
    let mut no_observed = wire;
    no_observed["observed"] = json!(null);
    assert!(from_value::<TransportStatusView>(no_observed)
        .unwrap()
        .observed
        .is_none());

    assert_eq!(
        to_value(CredentialStatus::Unconfigured).unwrap(),
        json!("unconfigured")
    );
    assert_eq!(
        to_value(CredentialStatus::Expired { generation: 2 }).unwrap(),
        json!({ "expired": { "generation": 2 } })
    );
    assert_eq!(
        to_value(CredentialStatus::UnsupportedInBrowser).unwrap(),
        json!("unsupported_in_browser")
    );
    assert_eq!(
        to_value(RuntimeStatus::NotLoaded).unwrap(),
        json!("not_loaded")
    );
    assert!(from_value::<CredentialStatus>(json!("healthy")).is_err());
}

#[test]
fn validate_binds_observations_and_probes_to_the_target() {
    let mut other_target = view();
    other_target.observed.as_mut().unwrap().target = "worker-tls".into();
    assert!(other_target.validate().is_err());
    let mut other_probe = view();
    if let EnforcementStatus::Verified { target, .. } = &mut other_probe.enforcement {
        *target = "worker-tls".into();
    }
    assert!(other_probe.validate().is_err());
    let mut bad_code = view();
    bad_code.runtime = RuntimeStatus::ReloadFailed {
        generation: 3,
        code: "network error".into(),
    };
    assert!(bad_code.validate().is_err());
    let mut bad_caps = view();
    bad_caps.capabilities.browser_vault_key_injection = CapabilityOutcome::Supported;
    assert!(bad_caps.validate().is_err());
    let mut bad_target = view();
    bad_target.target = "host tls".into();
    assert!(bad_target.validate().is_err());
    assert_eq!(view().observed.unwrap().peer.leaf_thumbprint_sha256, HEX_A);
}
