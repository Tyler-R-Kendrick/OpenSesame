//! Whether a runner already holds a web-login job for a target (ADR 0159).
//!
//! The Host's in-process registry keeps one run per `(organization, origin)`
//! inside one process. Replicas share a database and not a registry, so the
//! same exclusion is asked of the rows: a job is *held* when it is in a state
//! a runner walks through and its claim's lease has not run out. A job whose
//! lease lapsed is not held — its process is gone, and the reaper parks it —
//! and a running job with no claim on record (begun before claims were
//! persisted) is treated as held until the reaper has parked it.
//!
//! [`insert_unless_live`] is the one place a claimed job is created, as a
//! single `INSERT … SELECT … WHERE NOT EXISTS`, so no second runner can slip
//! between the check and the write.

use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;
use sqlx::{QueryBuilder, Sqlite};

use super::super::state_name;
use super::claim::ensure_claims;
use super::reap::RUNNING;
use crate::error::{BrokerError, Result};
use crate::store::RotationJobRow;
use crate::ConnectionBroker;

/// `SELECT 1 …` over the jobs of `organization_id` for `origin` that a runner
/// holds at `now`.
fn push_held<'a>(
    query: &mut QueryBuilder<'a, Sqlite>,
    organization_id: &'a str,
    origin: &'a str,
    now: &'a str,
) {
    query.push(
        "SELECT 1 FROM rotation_jobs j LEFT JOIN web_login_job_claims c ON c.job_id = j.id \
         WHERE j.target_kind = 'web_login' AND j.organization_id = ",
    );
    query.push_bind(organization_id);
    query.push(" AND j.target_id = ");
    query.push_bind(origin);
    query.push(" AND j.state IN (");
    let mut names = query.separated(", ");
    for state in RUNNING {
        names.push_bind(state_name(state));
    }
    query.push(") AND (c.lease_expires_at IS NULL OR c.lease_expires_at >= ");
    query.push_bind(now);
    query.push(")");
}

/// Insert `row` unless a runner holds a web-login job for the same
/// organization and origin.
///
/// # Errors
///
/// [`BrokerError::RunInFlight`] when one does; otherwise the write fails.
pub(super) async fn insert_unless_live(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    row: &RotationJobRow,
    now: DateTime<Utc>,
) -> Result<()> {
    let stamp = now.to_rfc3339();
    let mut query = QueryBuilder::<Sqlite>::new(
        "INSERT INTO rotation_jobs (id, policy_id, organization_id, target_kind, target_id, \
         state, detail, created_at, updated_at) SELECT ",
    );
    let mut values = query.separated(", ");
    values
        .push_bind(&row.id)
        .push_bind(&row.policy_id)
        .push_bind(&row.organization_id)
        .push_bind(&row.target_kind)
        .push_bind(&row.target_id)
        .push_bind(&row.state)
        .push_bind(&row.detail)
        .push_bind(&stamp)
        .push_bind(&stamp);
    query.push(" WHERE NOT EXISTS (");
    push_held(&mut query, &row.organization_id, &row.target_id, &stamp);
    query.push(")");
    let inserted = query.build().execute(&mut **tx).await?;
    if inserted.rows_affected() == 1 {
        Ok(())
    } else {
        Err(BrokerError::RunInFlight)
    }
}

/// Whether a runner holds a web-login job for `origin` in `organization_id`
/// right now — for a caller that wants to refuse before it queues work. The
/// answer can go stale; [`insert_unless_live`] is what actually decides.
///
/// # Errors
///
/// The jobs cannot be read.
pub async fn web_login_run_in_flight(
    broker: &ConnectionBroker,
    organization_id: &OrganizationId,
    origin: &str,
) -> Result<bool> {
    ensure_claims(&broker.pool).await?;
    let org = organization_id.to_string();
    let now = Utc::now().to_rfc3339();
    let mut query = QueryBuilder::<Sqlite>::new("SELECT EXISTS (");
    push_held(&mut query, &org, origin, &now);
    query.push(")");
    let held: i64 = query.build_query_scalar().fetch_one(&broker.pool).await?;
    Ok(held == 1)
}
