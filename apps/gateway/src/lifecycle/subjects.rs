//! Gathering everything with a deadline into one value-blind list.
//!
//! Each source contributes [`ExpirySubject`]s; the scanner does not care which
//! subsystem a deadline came from. That is the point of the split — adding a
//! source means adding a collector here, not teaching the scanner, the
//! dispatcher, or any subscriber about a new kind of thing.
//!
//! Collection never opens a sealed column. Deadlines come from plain columns
//! and, for authorities, from the public metadata document — so a scan needs
//! no sealing key and a scanner running without one is still useful.

use chrono::{DateTime, Utc};
use opensesame_connection_broker::{RotationPolicy, RotationTarget};
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::{ExpirySubject, SubjectKind};
use opensesame_storage::{Db, StoredCertificateAuthority, StoredManagedCertificate, StoredSigner};

use crate::app_state::AppState;

/// How far ahead certificates are pulled into a pass.
///
/// Wide enough that the 30-day notice rung is always reached with room to
/// spare, and bounded so a pass does not walk an entire inventory of
/// long-lived certificates every minute.
pub const CERTIFICATE_HORIZON_DAYS: i64 = 400;

/// Renewal lead for a rotation *schedule*.
///
/// A rotation policy is not a deadline that wants warning ahead of time — it
/// comes due, and the responder rotates. One second keeps the renewal rung on
/// the near side of the interval boundary so the first tick at or after the
/// due time fires it, preserving `policy_due_at`'s original semantics exactly.
pub const SCHEDULE_RENEW_BEFORE_SECONDS: i64 = 1;

fn parse_time(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

/// Every tracked deadline in one organization.
///
/// A source that fails is logged and skipped rather than aborting the pass:
/// one unreadable table must not stop a certificate elsewhere from being
/// renewed. Sources are merged by `(kind, subject_id)` with rotation policies
/// winning, because a policy is the operator's explicit schedule for a target
/// and outranks the credential's own advertised expiry.
pub async fn collect(
    state: &AppState,
    organization_id: &OrganizationId,
    now: DateTime<Utc>,
) -> Vec<ExpirySubject> {
    let organization = organization_id.to_string();
    let mut subjects: Vec<ExpirySubject> = Vec::new();

    // Collection order is load-bearing: rotation policies come last so
    // `dedupe`'s last-writer-wins lets a policy outrank a credential's own
    // advertised expiry.
    absorb(
        &mut subjects,
        certificates(&state.db, &organization, now).await,
        "certificates",
    );
    absorb(
        &mut subjects,
        authorities(&state.db, &organization).await,
        "authorities",
    );
    absorb(
        &mut subjects,
        signers(&state.db, &organization, now).await,
        "signers",
    );
    absorb(
        &mut subjects,
        connections(state, organization_id).await,
        "connections",
    );
    absorb(
        &mut subjects,
        rotation_policies(state, &organization).await,
        "rotation policies",
    );

    dedupe(subjects)
}

/// Add one source's subjects, or log why it contributed none.
///
/// A source that fails is skipped rather than fatal: one unreadable table must
/// not stop a certificate elsewhere from being renewed.
fn absorb(
    subjects: &mut Vec<ExpirySubject>,
    found: anyhow::Result<Vec<ExpirySubject>>,
    source: &'static str,
) {
    match found {
        Ok(found) => subjects.extend(found),
        Err(error) => tracing::warn!(%error, source, "lifecycle scan could not read a source"),
    }
}

/// Keep one subject per `(kind, subject_id)`, last writer winning.
///
/// Collection order puts rotation policies last on purpose: when a connection
/// both advertises a credential expiry and carries a rotation policy, the
/// policy is what the operator actually asked for.
fn dedupe(subjects: Vec<ExpirySubject>) -> Vec<ExpirySubject> {
    let mut keyed: std::collections::BTreeMap<(SubjectKind, String), ExpirySubject> =
        std::collections::BTreeMap::new();
    for subject in subjects {
        keyed.insert((subject.kind, subject.subject_id.clone()), subject);
    }
    keyed.into_values().collect()
}

async fn certificates(
    db: &Db,
    organization: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<Vec<ExpirySubject>> {
    let horizon = (now + chrono::Duration::days(CERTIFICATE_HORIZON_DAYS)).to_rfc3339();
    let rows = db
        .list_certificates_expiring_before(organization, &horizon)
        .await?;
    Ok(rows.into_iter().filter_map(certificate_subject).collect())
}

fn certificate_subject(row: StoredManagedCertificate) -> Option<ExpirySubject> {
    Some(ExpirySubject {
        kind: SubjectKind::Certificate,
        expires_at: parse_time(&row.expires_at)?,
        renew_before_seconds: row.renew_before_seconds,
        auto_respond: row.auto_renew_enabled,
        alerting: true,
        label: Some(row.common_name),
        subject_id: row.id,
        organization_id: row.organization_id,
    })
}

/// Authorities whose public metadata records a `not_after`.
///
/// Authorities minted before the Certificate Manager's `CaFacts` document
/// carry no parsed validity, and this deliberately does not crack open the
/// sealed material to find one: an untracked authority is reported as absent
/// rather than guessed at.
async fn authorities(db: &Db, organization: &str) -> anyhow::Result<Vec<ExpirySubject>> {
    let rows = db.list_certificate_authorities(organization).await?;
    Ok(rows
        .into_iter()
        .filter(|row| row.status == "active")
        .filter_map(authority_subject)
        .collect())
}

fn authority_subject(row: StoredCertificateAuthority) -> Option<ExpirySubject> {
    let metadata: serde_json::Value = serde_json::from_str(&row.public_metadata_json).ok()?;
    let not_after = metadata.get("not_after")?.as_str()?;
    Some(ExpirySubject {
        kind: SubjectKind::CertificateAuthority,
        expires_at: parse_time(not_after)?,
        // An authority is never rotated unattended: re-keying a CA changes
        // trust for everything it signed (ADR 0052-cert). Alert only.
        renew_before_seconds: None,
        auto_respond: false,
        alerting: true,
        label: Some(row.display_name),
        subject_id: row.id,
        organization_id: row.organization_id,
    })
}

/// Signers, whose deadline is their bound certificate's.
async fn signers(
    db: &Db,
    organization: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<Vec<ExpirySubject>> {
    let signers = db.list_signers(organization).await?;
    if signers.is_empty() {
        return Ok(Vec::new());
    }
    let horizon = (now + chrono::Duration::days(CERTIFICATE_HORIZON_DAYS)).to_rfc3339();
    let certificates = db
        .list_certificates_expiring_before(organization, &horizon)
        .await?;
    Ok(signers
        .into_iter()
        .filter(|signer| signer.status == "active")
        .filter_map(|signer| signer_subject(signer, &certificates))
        .collect())
}

fn signer_subject(
    signer: StoredSigner,
    certificates: &[StoredManagedCertificate],
) -> Option<ExpirySubject> {
    let certificate_id = signer.certificate_id.as_deref()?;
    let certificate = certificates
        .iter()
        .find(|candidate| candidate.id == certificate_id)?;
    Some(ExpirySubject {
        kind: SubjectKind::Signer,
        expires_at: parse_time(&certificate.expires_at)?,
        renew_before_seconds: signer.renew_before_seconds,
        auto_respond: signer.auto_renew,
        alerting: true,
        label: Some(signer.name),
        subject_id: signer.id,
        organization_id: signer.organization_id,
    })
}

/// Brokered credentials that advertise their own expiry.
///
/// Alert-only, always. Refreshing an access token is the broker's own business
/// on the invoke path, and an unattended *rotation* is something an operator
/// asks for by writing a rotation policy — which then supersedes this subject
/// in [`dedupe`]. A credential with no policy therefore reports its deadline
/// and nothing more: subscribers are told so they can drive a re-consent flow,
/// and the platform does not invent a rotation nobody requested.
async fn connections(
    state: &AppState,
    organization_id: &OrganizationId,
) -> anyhow::Result<Vec<ExpirySubject>> {
    let views = state
        .connection_broker
        .list_connections(organization_id)
        .await
        .map_err(|error| anyhow::anyhow!("{}", error.hint()))?;
    Ok(views
        .into_iter()
        .filter_map(|view| {
            Some(ExpirySubject {
                kind: SubjectKind::ConnectionCredential,
                expires_at: parse_time(view.expires_at.as_deref()?)?,
                renew_before_seconds: None,
                auto_respond: false,
                alerting: true,
                label: Some(view.provider_id),
                subject_id: view.connection_id,
                organization_id: view.organization_id,
            })
        })
        .collect())
}

/// Rotation policies, as schedules rather than deadlines.
///
/// This is the collector that makes rotation a hook consumer: the policy's
/// next due time becomes a subject deadline, the renewal rung fires when it
/// arrives, and the rotation responder is what actually rotates. There is no
/// separate "is this policy due" code path any more.
async fn rotation_policies(
    state: &AppState,
    organization: &str,
) -> anyhow::Result<Vec<ExpirySubject>> {
    let policies = state
        .connection_broker
        .list_enabled_rotation_policies()
        .await
        .map_err(|error| anyhow::anyhow!("{}", error.hint()))?;
    Ok(policies
        .into_iter()
        .filter(|policy| policy.organization_id == organization)
        .filter_map(policy_subject)
        .collect())
}

/// A policy that has never run, expressed as a deadline already past.
///
/// It has to be a *stable* instant, not `now`: the ladder resets whenever a
/// subject's deadline moves, so a drifting sentinel would re-fire the renewal
/// rung on every tick and rotate on every tick with it. It also has to leave
/// room underneath — the ladder dates a rung by subtracting its threshold from
/// the deadline, and `DateTime::MIN_UTC` overflows the moment it does.
const NEVER_ROTATED: DateTime<Utc> = DateTime::UNIX_EPOCH;

/// A policy's deadline is the moment it next comes due.
///
/// A policy that has never run is due immediately, which
/// [`opensesame_connection_broker::policy_due_at`] also says — expressed here
/// as [`NEVER_ROTATED`], which lands on the actionable rung.
pub fn policy_subject(policy: RotationPolicy) -> Option<ExpirySubject> {
    let interval = chrono::Duration::from_std(policy.interval_duration()).ok()?;
    let expires_at = match policy.last_rotated() {
        Some(last) => last.checked_add_signed(interval)?,
        None => NEVER_ROTATED,
    };
    let (kind, subject_id) = match &policy.target {
        RotationTarget::Connection { connection_id } => {
            (SubjectKind::ConnectionCredential, connection_id.clone())
        }
        RotationTarget::StorePath { path } => (SubjectKind::StorePath, path.clone()),
    };
    Some(ExpirySubject {
        kind,
        subject_id,
        organization_id: policy.organization_id.clone(),
        expires_at,
        renew_before_seconds: Some(SCHEDULE_RENEW_BEFORE_SECONDS),
        auto_respond: policy.enabled,
        // A schedule does not narrate: its deadline moves on every rotation,
        // which resets the ladder, so an hourly policy would re-fire the whole
        // alert track hourly.
        alerting: false,
        label: Some(policy.id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_connection_broker::RotationPolicy;

    fn policy(interval_seconds: u64, last_rotated_at: Option<&str>) -> RotationPolicy {
        RotationPolicy {
            id: "pol:1".into(),
            organization_id: "org:1".into(),
            target: RotationTarget::Connection {
                connection_id: "conn:1".into(),
            },
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
        let subject =
            policy_subject(policy(7 * 86_400, Some("2026-08-30T00:00:00+00:00"))).unwrap();
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
}
