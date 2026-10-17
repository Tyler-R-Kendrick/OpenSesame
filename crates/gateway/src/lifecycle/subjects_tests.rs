//! Collector tests, beside `subjects.rs` so it stays inside its size budget
//! (ADR 0093).

use super::*;
use opensesame_connection_broker::RotationPolicy;

fn policy(interval_seconds: u64, last_rotated_at: Option<&str>) -> RotationPolicy {
    RotationPolicy {
        id: "pol:1".into(),
        organization_id: "org:1".into(),
        target: RotationTarget::Connection {
            connection_id: "conn:1".into(),
        },
        owner_subject: None,
        interval_seconds,
        last_rotated_at: last_rotated_at.map(str::to_string),
        enabled: true,
        attempts: 0,
        next_attempt_at: None,
        needs_attention: false,
        last_error: None,
        created_at: "2026-08-30T00:00:00+00:00".into(),
        updated_at: "2026-08-30T00:00:00+00:00".into(),
    }
}

fn certificate(id: &str, expires_at: &str, auto_renew: bool) -> StoredManagedCertificate {
    StoredManagedCertificate {
        id: id.into(),
        organization_id: "org:1".into(),
        authority_id: "ca:1".into(),
        request_id: "req:1".into(),
        certificate_digest: "sha256:x".into(),
        serial_number: "01".into(),
        common_name: "api.example".into(),
        san_json: r#"{"dns_names":[],"ip_addrs":[]}"#.into(),
        not_before: "2026-08-01T00:00:00+00:00".into(),
        expires_at: expires_at.into(),
        status: "active".into(),
        application_id: None,
        profile_id: None,
        source: "managed".into(),
        enrollment_method: None,
        metadata_json: "{}".into(),
        key_algorithm: None,
        signature_algorithm: None,
        fingerprint_sha256: None,
        chain_pem: None,
        renewed_from_id: None,
        renewed_by_id: None,
        auto_renew_enabled: auto_renew,
        renew_before_seconds: Some(86_400),
        revocation_reason: None,
        revoked_at: None,
        version: 1,
        created_at: "2026-08-01T00:00:00+00:00".into(),
        updated_at: "2026-08-01T00:00:00+00:00".into(),
    }
}

#[test]
fn a_never_rotated_policy_is_due_immediately() {
    let subject = policy_subject(policy(3_600, None)).unwrap();
    assert!(subject.expires_at < Utc::now());
    assert!(subject.auto_respond);
    assert!(!subject.alerting, "a schedule must not narrate");
}

#[test]
fn the_never_rotated_sentinel_is_stable_and_leaves_room_underneath() {
    // Stable: a sentinel derived from `now` would move every tick, which
    // resets the ladder, which would rotate on every tick.
    let first = policy_subject(policy(3_600, None)).unwrap().expires_at;
    let second = policy_subject(policy(3_600, None)).unwrap().expires_at;
    assert_eq!(first, second);

    // Room underneath: the inventory dates each rung by subtracting its
    // threshold from the deadline, and `DateTime::MIN_UTC` overflows.
    for stage in opensesame_lifecycle::ExpiryStage::ALL {
        let threshold = stage.threshold_seconds(opensesame_lifecycle::NOTICE_SECONDS);
        assert!(
            first
                .checked_sub_signed(chrono::Duration::seconds(threshold))
                .is_some(),
            "dating {stage:?} must not overflow",
        );
    }
}

#[test]
fn a_policy_deadline_is_its_last_run_plus_the_interval() {
    let subject = policy_subject(policy(3_600, Some("2026-08-30T00:00:00+00:00"))).unwrap();
    assert_eq!(
        subject.expires_at,
        "2026-08-30T01:00:00Z".parse::<DateTime<Utc>>().unwrap(),
    );
}

#[test]
fn a_policy_targets_its_target_not_itself() {
    // The subject id is the thing rotated, so a connection's policy and
    // that connection's own credential expiry collapse onto one subject
    // rather than racing as two.
    let subject = policy_subject(policy(3_600, None)).unwrap();
    assert_eq!(subject.kind, SubjectKind::ConnectionCredential);
    assert_eq!(subject.subject_id, "conn:1");
    assert_eq!(subject.label.as_deref(), Some("pol:1"));

    let mut store = policy(3_600, None);
    store.target = RotationTarget::StorePath {
        path: "Dev/api-token".into(),
    };
    let subject = policy_subject(store).unwrap();
    assert_eq!(subject.kind, SubjectKind::StorePath);
    assert_eq!(subject.subject_id, "Dev/api-token");
}

#[test]
fn a_policy_renewal_lead_does_not_rotate_early() {
    // A 7-day default lead would rotate a 7-day policy the instant it ran.
    let subject = policy_subject(policy(7 * 86_400, Some("2026-08-30T00:00:00+00:00"))).unwrap();
    assert_eq!(subject.renew_before(), SCHEDULE_RENEW_BEFORE_SECONDS);
    let events = opensesame_lifecycle::evaluate(
        &subject,
        opensesame_lifecycle::Watermarks::default(),
        "2026-08-31T00:00:00Z".parse().unwrap(),
    );
    assert!(events.is_empty(), "a day in, nothing is due: {events:?}");
}

#[test]
fn a_certificate_carries_its_own_renewal_settings() {
    let subject = certificate_subject(certificate("cert:1", "2026-09-30T00:00:00+00:00", true))
        .expect("certificate is a subject");
    assert_eq!(subject.kind, SubjectKind::Certificate);
    assert!(subject.auto_respond);
    assert!(subject.alerting);
    assert_eq!(subject.renew_before_seconds, Some(86_400));
    assert_eq!(subject.label.as_deref(), Some("api.example"));
}

#[test]
fn a_certificate_with_an_unparseable_deadline_is_skipped() {
    let subject = certificate_subject(certificate("cert:1", "not a timestamp", true));
    assert!(
        subject.is_none(),
        "a garbled deadline is skipped, not guessed"
    );
}

#[test]
fn an_authority_is_alert_only_and_needs_a_recorded_not_after() {
    let mut row = StoredCertificateAuthority {
        id: "ca:1".into(),
        organization_id: "org:1".into(),
        issuer_kind: "internal".into(),
        issuer_connection_id: None,
        display_name: "OpenSesame Private CA".into(),
        public_metadata_json: r#"{"not_after":"2027-08-30T00:00:00+00:00"}"#.into(),
        sealed_material: opensesame_storage::SealedCertificateMaterial {
            key_id: "seal:ca".into(),
            ciphertext: vec![1],
            nonce: vec![2],
            aad_digest: "sha256:x".into(),
        },
        is_default: true,
        status: "active".into(),
        version: 1,
        created_at: "2026-08-01T00:00:00+00:00".into(),
        updated_at: "2026-08-01T00:00:00+00:00".into(),
    };
    let subject = authority_subject(row.clone()).expect("authority is a subject");
    assert_eq!(subject.kind, SubjectKind::CertificateAuthority);
    assert!(
        !subject.auto_respond,
        "re-keying a CA changes trust for everything it signed",
    );

    // Legacy authorities carry no parsed validity, and the collector must
    // report them absent rather than crack the sealed material open.
    row.public_metadata_json = r#"{"trust_scope":"private_local"}"#.into();
    assert!(authority_subject(row).is_none());
}

#[test]
fn a_signer_inherits_its_certificates_deadline() {
    let certificates = vec![certificate("cert:1", "2026-09-30T00:00:00+00:00", false)];
    let signer = StoredSigner {
        id: "signer:1".into(),
        organization_id: "org:1".into(),
        name: "release".into(),
        certificate_id: Some("cert:1".into()),
        key_source: "sealed".into(),
        hsm_connector_id: None,
        hsm_key_label: None,
        status: "active".into(),
        auto_renew: true,
        renew_before_seconds: Some(172_800),
        sealed_key: None,
        version: 1,
        created_at: "2026-08-01T00:00:00+00:00".into(),
        updated_at: "2026-08-01T00:00:00+00:00".into(),
    };
    let subject = signer_subject(signer.clone(), &certificates).unwrap();
    assert_eq!(subject.kind, SubjectKind::Signer);
    assert_eq!(
        subject.expires_at,
        "2026-09-30T00:00:00Z".parse::<DateTime<Utc>>().unwrap(),
    );
    assert_eq!(subject.renew_before_seconds, Some(172_800));

    // An unbound signer has no deadline to track.
    let mut unbound = signer;
    unbound.certificate_id = None;
    assert!(signer_subject(unbound, &certificates).is_none());
}

#[test]
fn a_rotation_policy_outranks_a_credentials_own_expiry() {
    let credential = ExpirySubject {
        kind: SubjectKind::ConnectionCredential,
        subject_id: "conn:1".into(),
        organization_id: "org:1".into(),
        expires_at: "2026-12-31T00:00:00Z".parse().unwrap(),
        renew_before_seconds: None,
        auto_respond: true,
        alerting: true,
        label: Some("github".into()),
    };
    let scheduled = policy_subject(policy(3_600, Some("2026-08-30T00:00:00+00:00"))).unwrap();
    let merged = dedupe(vec![credential, scheduled]);
    assert_eq!(merged.len(), 1, "one subject per target: {merged:?}");
    assert!(!merged[0].alerting, "the policy's schedule wins");
    assert_eq!(merged[0].label.as_deref(), Some("pol:1"));
}

fn grant(expires_at: &str) -> SessionGrant {
    SessionGrant::new(opensesame_domain::NewSessionGrant {
        id: opensesame_domain::SessionGrantId::new(),
        session_id: opensesame_domain::SessionId::new(),
        subject_principal_id: opensesame_domain::PrincipalId::new(),
        granted_by_principal_id: opensesame_domain::PrincipalId::new(),
        scope: opensesame_domain::GrantScope::Collection {
            vault_id: opensesame_domain::VaultId::new(),
        },
        role: opensesame_domain::SessionRole::Read,
        granted_at: "2026-08-30T00:00:00Z".parse().unwrap(),
        expires_at: expires_at.parse().unwrap(),
        link: opensesame_domain::GrantLink::LifecycleBound,
    })
    .expect("a grant inside the bounds")
}

#[test]
fn a_session_grant_subject_carries_no_label() {
    // The one that matters. Every other kind labels itself with something
    // an operator recognises; a grant's equivalent would name the vault or
    // the row, which ADR 0079 forbids on a session surface. A future
    // change that "improves" this by adding a label leaks it to every
    // subscriber, including one granted a different row.
    let subject = session_grant_subject(&grant("2026-09-02T00:00:00Z"), "org:1");
    assert_eq!(subject.label, None);
}

#[test]
fn a_session_grant_subject_names_the_grant_and_nothing_underneath_it() {
    let live = grant("2026-09-02T00:00:00Z");
    let subject = session_grant_subject(&live, "org:1");
    assert_eq!(subject.subject_id, live.id.to_string());
    assert_eq!(subject.organization_id, "org:1");
    assert_eq!(subject.expires_at, live.expires_at);

    // Nothing serialized from the subject may name the vault: the scope is
    // the operator's business, not the feed's.
    let vault = match &live.scope {
        opensesame_domain::GrantScope::Collection { vault_id }
        | opensesame_domain::GrantScope::Rows { vault_id, .. } => vault_id.to_string(),
    };
    let json = serde_json::to_string(&subject).unwrap();
    assert!(
        !json.contains(&vault),
        "a grant's lifecycle subject named the vault it reaches"
    );
}

#[test]
fn a_session_grant_alerts_but_can_never_be_acted_on() {
    let subject = session_grant_subject(&grant("2026-09-02T00:00:00Z"), "org:1");
    // Told, always.
    assert!(subject.alerting, "a lapsing grant must still narrate");
    // Acted on, never — by the kind, which is what actually refuses, and
    // by the flag, which is what a reader of the stored row sees.
    assert!(!subject.kind.renewable());
    assert!(!subject.auto_respond);
    for stage in opensesame_lifecycle::ExpiryStage::ALL {
        let event =
            opensesame_lifecycle::LifecycleEvent::for_stage(subject.clone(), stage, Utc::now());
        assert!(
            !opensesame_lifecycle::should_respond(&event),
            "the platform offered to act on a session grant at {stage:?}"
        );
    }
}

#[test]
fn a_grant_subject_does_not_collide_with_a_certificate_of_the_same_id() {
    let live = grant("2026-09-02T00:00:00Z");
    let mut twin = session_grant_subject(&live, "org:1");
    twin.kind = SubjectKind::Certificate;
    let merged = dedupe(vec![session_grant_subject(&live, "org:1"), twin]);
    assert_eq!(merged.len(), 2);
}

#[test]
fn subjects_of_different_kinds_never_collide() {
    let shared_id = "same";
    let subjects: Vec<ExpirySubject> = [SubjectKind::Certificate, SubjectKind::Signer]
        .into_iter()
        .map(|kind| ExpirySubject {
            kind,
            subject_id: shared_id.into(),
            organization_id: "org:1".into(),
            expires_at: "2026-12-31T00:00:00Z".parse().unwrap(),
            renew_before_seconds: None,
            auto_respond: false,
            alerting: true,
            label: None,
        })
        .collect();
    assert_eq!(dedupe(subjects).len(), 2);
}
