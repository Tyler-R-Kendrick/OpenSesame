//! Generalized authority deadlines for the lifecycle scanner (INV-GA-05).
//!
//! Mirrors [`super::subjects`]' session-grant collector: alerts, never
//! auto-responds, and carries no label that could name a secret or resource.

use opensesame_lifecycle::{ExpirySubject, SubjectKind};
use opensesame_storage::authority::AuthorityGrantDeadline;
use opensesame_storage::Db;

/// Cap per organization per pass — soonest-first, so near deadlines win.
pub const AUTHORITY_GRANT_SCAN_LIMIT: i64 = 512;

/// Renewal lead kept minimal: the kind is non-renewable, so the rung exists
/// only to keep the ladder well-formed.
pub const AUTHORITY_GRANT_RENEW_BEFORE_SECONDS: i64 = 1;

/// Unrevoked `grant_authority` rows as expiry subjects.
pub async fn authority_grants(
    db: &Db,
    organization: &str,
) -> anyhow::Result<Vec<ExpirySubject>> {
    let grants = db
        .authority_grants_expiring(organization, AUTHORITY_GRANT_SCAN_LIMIT)
        .await?;
    Ok(grants
        .into_iter()
        .map(|grant| authority_grant_subject(&grant, organization))
        .collect())
}

/// Identity and deadline only — no secret-shaped fields, no resource label.
fn authority_grant_subject(grant: &AuthorityGrantDeadline, organization: &str) -> ExpirySubject {
    ExpirySubject {
        kind: SubjectKind::AuthorityGrant,
        subject_id: grant.grant_id.clone(),
        organization_id: organization.to_string(),
        expires_at: grant.expires_at,
        renew_before_seconds: Some(AUTHORITY_GRANT_RENEW_BEFORE_SECONDS),
        auto_respond: false,
        alerting: true,
        label: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use opensesame_lifecycle::{evaluate, should_respond, Watermarks, EVENT_EXPIRY_EXPIRED};

    fn deadline(expires_at: chrono::DateTime<Utc>) -> AuthorityGrantDeadline {
        AuthorityGrantDeadline {
            grant_id: "grant:1".into(),
            organization_id: "org:1".into(),
            not_before: expires_at - Duration::hours(1),
            expires_at,
        }
    }

    #[test]
    fn authority_grant_subject_alerts_but_never_auto_responds() {
        let subject = authority_grant_subject(&deadline(Utc::now()), "org:1");
        assert_eq!(subject.kind, SubjectKind::AuthorityGrant);
        assert!(!subject.auto_respond);
        assert!(subject.alerting);
        assert_eq!(subject.label, None);
        assert!(!subject.kind.renewable());
    }

    #[test]
    fn past_expires_at_emits_lifecycle_expiry_expired() {
        let expires_at = "2026-09-01T00:00:00Z".parse().unwrap();
        let subject = authority_grant_subject(&deadline(expires_at), "org:1");
        let now = "2026-09-01T00:01:00Z".parse().unwrap();
        let events = evaluate(&subject, Watermarks::default(), now);
        assert!(
            events
                .iter()
                .any(|event| event.event_type == EVENT_EXPIRY_EXPIRED),
            "expected {EVENT_EXPIRY_EXPIRED}, got {events:?}"
        );
        for event in &events {
            assert!(!should_respond(event), "{}", event.event_type);
        }
    }
}
