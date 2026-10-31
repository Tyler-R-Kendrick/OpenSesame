//! Minted AWS credentials as expiry subjects (ADR 0217, ADR 0074).
//!
//! An STS credential the Host minted expires on STS's clock, and that deadline
//! is published on the lifecycle feed like any other: from the mint register's
//! plain columns, never from a sealed one. Each mint is a
//! `connection_credential` subject named by its grant id. Like a session or
//! authority grant it alerts and is never auto-responded to: nothing renews a
//! minted credential, and the agent that needs another one mints again. The
//! alert track is what tells subscribers it lapsed (`lifecycle.expiry.expired`);
//! a credential that lives under a day reaches `urgent` on its first pass.

use chrono::{DateTime, Duration, Utc};
use opensesame_domain::OrganizationId;
use opensesame_lifecycle::{ExpirySubject, SubjectKind};

use crate::app_state::AppState;

/// Cap on each of a pass's two reads per organization: live mints soonest
/// first, and lapsed ones most recently lapsed first, so a full window of
/// mints whose expiry is already published never crowds out a newer one.
pub const MINT_SCAN_LIMIT: i64 = 512;

/// How long after its expiry a mint is still collected, so the pass that
/// follows the deadline sees it and the `expired` rung fires.
pub const EXPIRED_GRACE_SECONDS: i64 = 24 * 60 * 60;

/// The renewal rung is meaningless for a credential nothing renews; keep it
/// minimal so the ladder stays well-formed.
pub const MINT_RENEW_BEFORE_SECONDS: i64 = 1;

/// Every minted AWS credential in one organization still live, or lapsed
/// within the grace window.
///
/// # Errors
///
/// When the register cannot be read.
pub async fn aws_sts_mints(
    state: &AppState,
    organization_id: &OrganizationId,
    now: DateTime<Utc>,
) -> anyhow::Result<Vec<ExpirySubject>> {
    let since = now - Duration::seconds(EXPIRED_GRACE_SECONDS);
    let deadlines = state
        .connection_broker
        .aws_sts_mint_deadlines(organization_id, now, since, MINT_SCAN_LIMIT)
        .await
        .map_err(|error| anyhow::anyhow!("{}", error.hint()))?;
    Ok(deadlines
        .into_iter()
        .map(|deadline| ExpirySubject {
            kind: SubjectKind::ConnectionCredential,
            subject_id: format!("aws-sts-mint:{}", deadline.grant_id),
            organization_id: deadline.organization_id,
            expires_at: deadline.expires_at,
            renew_before_seconds: Some(MINT_RENEW_BEFORE_SECONDS),
            auto_respond: false,
            alerting: true,
            label: Some("aws-sts".into()),
        })
        .collect())
}

#[cfg(test)]
#[path = "minted_subjects_tests.rs"]
mod tests;
