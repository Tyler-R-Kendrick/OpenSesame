//! Who admits a person into a session: its operator, or its policy (ADR 0137).
//!
//! Kept beside, not inside, [`super::StoredSession`]: the policy is read at
//! exactly two moments — someone asks, or someone lists what they may ask
//! into — and every other reader of a session has no use for it.

use anyhow::Context;
use opensesame_domain::{SessionAdmission, SessionId};
use sqlx::Row;
use std::collections::BTreeSet;

use super::{visibility_str, StoredSession};
use crate::Db;

impl Db {
    /// Open a session under an admission policy. The storage CHECK refuses a
    /// spelling the domain does not know; the route refuses a policy that
    /// does not fit the session's visibility before it gets here.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn create_session_admitting(
        &self,
        session: &StoredSession,
        admission: SessionAdmission,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO sessions (id, organization_id, project_id, \
             operator_principal_id, display_name, visibility, created_at, closed_at, admission) \
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(session.id.to_string())
        .bind(&session.organization_id)
        .bind(session.operator_principal_id.to_string())
        .bind(&session.display_name)
        .bind(visibility_str(session.visibility))
        .bind(session.created_at.to_rfc3339())
        .bind(session.closed_at.map(|at| at.to_rfc3339()))
        .bind(admission.as_str())
        .execute(&self.pool)
        .await
        .context("insert session")?;
        Ok(())
    }

    /// How one session admits. A spelling the domain does not know is an
    /// error, never read as the nearest policy.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is unreadable.
    pub async fn session_admission(
        &self,
        organization_id: &str,
        session: SessionId,
    ) -> anyhow::Result<SessionAdmission> {
        let raw: String =
            sqlx::query("SELECT admission FROM sessions WHERE organization_id = ?1 AND id = ?2")
                .bind(organization_id)
                .bind(session.to_string())
                .fetch_one(&self.pool)
                .await
                .context("select session admission")?
                .get("admission");
        SessionAdmission::parse(&raw).context("unknown session admission")
    }

    /// The open, public sessions in one organization that admit on ask.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or an id is unreadable.
    pub async fn sessions_admitting_on_ask(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<BTreeSet<SessionId>> {
        let rows = sqlx::query(
            "SELECT id FROM sessions WHERE organization_id = ?1 AND visibility = 'public' \
             AND closed_at IS NULL AND admission = 'observer_on_ask'",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await
        .context("select sessions admitting on ask")?;
        rows.iter()
            .map(|row| SessionId::parse(&row.get::<String, _>("id")).context("session id"))
            .collect()
    }
}
