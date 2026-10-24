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
use opensesame_domain::SessionGrant;
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

/// Cap per org on each of a pass's two session-grant reads, live and lapsed (ADR 0074 §1).
pub const SESSION_GRANT_SCAN_LIMIT: i64 = 512;

/// Minimal renewal lead: kind is non-renewable, so the rung only shapes the ladder.
pub const SESSION_GRANT_RENEW_BEFORE_SECONDS: i64 = 1;

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
        session_grants(&state.db, &organization, now).await,
        "session grants",
    );
    absorb(
        &mut subjects,
        super::authority_subjects::authority_grants(&state.db, &organization, now).await,
        "authority grants",
    );
    absorb(
        &mut subjects,
        super::minted_subjects::aws_sts_mints(state, organization_id, now).await,
        "minted aws credentials",
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

/// One participant's reach into a shared session (ADR 0079).
///
/// This is the collector that makes a grant's TTL real on the public feed
/// rather than in a private timer somewhere. It is also the one collector
/// whose subject **must never be acted on**: `SubjectKind::SessionGrant` is
/// not renewable, so the ladder narrates a grant's last hours and the
/// responder table has nothing to answer it with.
///
/// The read leaves out revoked grants: one ended when it was revoked, and
/// announcing it as "expiring" would tell subscribers a participant still has
/// reach they lost. It reads lapsed grants apart from live ones, so expiries
/// already published never crowd a live grant out of a pass.
async fn session_grants(
    db: &Db,
    organization: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<Vec<ExpirySubject>> {
    let grants = db.session_grants_expiring(organization, now, SESSION_GRANT_SCAN_LIMIT);
    let subject = |grant| session_grant_subject(&grant, organization);
    Ok(grants.await?.into_iter().map(subject).collect())
}

/// A grant's deadline, carrying its identity and nothing else.
///
/// **`label` is `None`, and that is the security decision in this function.**
/// Every other subject kind labels itself with something an operator would
/// recognise — a common name, a store path, a provider. A session grant's
/// equivalent would be the vault or the row it reaches, and ADR 0079 §2 puts
/// item labels on the list of things that must never cross a session surface:
/// a hook payload reading "expiring: AWS root credentials" tells every
/// subscriber what a participant was holding, including subscribers granted a
/// different row entirely. The grant id is enough to look it up with authority
/// the feed does not carry.
///
/// `auto_respond` is `false` as well as the kind being non-renewable. Belt and
/// braces on purpose: the kind is what actually refuses, and this is what a
/// reader of a stored subject sees.
fn session_grant_subject(grant: &SessionGrant, organization: &str) -> ExpirySubject {
    ExpirySubject {
        kind: SubjectKind::SessionGrant,
        subject_id: grant.id.to_string(),
        organization_id: organization.to_string(),
        expires_at: grant.expires_at,
        renew_before_seconds: Some(SESSION_GRANT_RENEW_BEFORE_SECONDS),
        auto_respond: false,
        // Somebody whose access lapses in an hour is exactly who the alert
        // ladder exists for. Refusing to *act* is not refusing to *tell*.
        alerting: true,
        label: None,
    }
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
        RotationTarget::WebLogin { origin } => (SubjectKind::WebLogin, origin.clone()),
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
#[path = "subjects_tests.rs"]
mod tests;
