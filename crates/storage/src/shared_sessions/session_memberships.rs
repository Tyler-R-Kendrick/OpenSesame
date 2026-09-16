//! Seats in a session, and what closing one takes back (ADR 0079 §2, §7).
//!
//! Split from [`crate::shared_sessions`] because it answers a different
//! question. That module persists *reach* — who may open which rows, until
//! when. This one persists *presence*: who is in the room, in which mode, and
//! nothing else. The separation is the point rather than tidiness, since
//! ADR 0079's original shape made presence a consequence of reach and so could
//! not seat somebody who needed none.
//!
//! Two rules live here rather than in a caller:
//!
//! **A seat never carries reach.** Nothing in this module writes to
//! `session_grants`, and nothing it returns can be turned into an
//! authorization. Whether an observer may be granted anything is
//! [`opensesame_domain::SessionMembership::assert_may_hold_grant`]'s question,
//! asked where the grant is minted.
//!
//! **Closing is one transaction, and it is selective.**
//! [`Db::close_session`] shuts the session, ends every seat, and revokes every
//! grant the session *minted* — and deliberately leaves every `referenced`
//! grant alone, because that reach belongs to another road and ending a
//! meeting must not revoke a colleague's project access. Doing the three
//! writes separately would leave a window in which the session is over and its
//! grants still authorize.

use anyhow::{bail, Context};
use chrono::{DateTime, Utc};
use opensesame_domain::{PrincipalId, SessionId, SessionMembership, SessionMode};
use sqlx::{sqlite::SqliteRow, Row};

use crate::Db;

pub(crate) fn mode_from(raw: &str) -> anyhow::Result<SessionMode> {
    match raw {
        "observer" => Ok(SessionMode::Observer),
        "participant" => Ok(SessionMode::Participant),
        other => bail!("unknown session mode '{other}'"),
    }
}

pub(crate) fn mode_str(mode: SessionMode) -> &'static str {
    match mode {
        SessionMode::Observer => "observer",
        SessionMode::Participant => "participant",
    }
}

fn stored_membership(row: &SqliteRow) -> anyhow::Result<SessionMembership> {
    let session_id: String = row.get("session_id");
    let principal_id: String = row.get("principal_id");
    let admitted_by: String = row.get("admitted_by_principal_id");
    let mode: String = row.get("mode");
    let admitted_at: String = row.get("admitted_at");
    let ended_at: Option<String> = row.get("ended_at");
    Ok(SessionMembership {
        session_id: SessionId::parse(&session_id).context("session id")?,
        principal_id: PrincipalId::parse(&principal_id).context("member principal")?,
        mode: mode_from(&mode)?,
        admitted_by_principal_id: PrincipalId::parse(&admitted_by)
            .context("admitting principal")?,
        admitted_at: crate::shared_sessions::parse_time(&admitted_at, "admitted_at")?,
        ended_at: crate::shared_sessions::parse_optional_time(ended_at, "ended_at")?,
    })
}

impl Db {
    /// Seat somebody, or change the mode of a seat they already hold.
    ///
    /// Upsert rather than insert-or-fail because the operations a caller
    /// actually performs — admit, raise, lower, re-admit somebody who left —
    /// are all "this principal's seat in this session is now *this*". The
    /// primary key on the pair is what keeps a principal from holding two
    /// seats in two modes; an insert-only path would need the caller to know
    /// which case it was in, and a caller that guessed wrong would create the
    /// contradiction the key exists to prevent.
    ///
    /// `admitted_at` and `admitted_by` are left as first written when a seat
    /// already exists: raising a member is not re-admitting them, and
    /// overwriting would erase who let them in.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn upsert_session_membership(
        &self,
        organization_id: &str,
        membership: &SessionMembership,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO session_memberships (session_id, organization_id, \
             principal_id, mode, admitted_by_principal_id, admitted_at, ended_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT (session_id, principal_id) DO UPDATE SET \
             mode = excluded.mode, ended_at = excluded.ended_at",
        )
        .bind(membership.session_id.to_string())
        .bind(organization_id)
        .bind(membership.principal_id.to_string())
        .bind(mode_str(membership.mode))
        .bind(membership.admitted_by_principal_id.to_string())
        .bind(membership.admitted_at.to_rfc3339())
        .bind(membership.ended_at.map(|at| at.to_rfc3339()))
        .execute(&self.pool)
        .await
        .context("upsert session membership")?;
        Ok(())
    }

    /// One principal's seat, whatever state it is in.
    ///
    /// Returns ended seats too. The caller asks
    /// [`SessionMembership::is_active`] — telling "left the room" apart from
    /// "was never in it" is a distinction the roster needs, and collapsing
    /// them here would take it away.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or the stored row cannot be read.
    pub async fn session_membership(
        &self,
        session_id: SessionId,
        principal_id: PrincipalId,
    ) -> anyhow::Result<Option<SessionMembership>> {
        let row = sqlx::query(
            "SELECT * FROM session_memberships WHERE session_id = ?1 AND principal_id = ?2",
        )
        .bind(session_id.to_string())
        .bind(principal_id.to_string())
        .fetch_optional(&self.pool)
        .await
        .context("select session membership")?;
        row.as_ref().map(stored_membership).transpose()
    }

    /// Everybody currently in one session.
    ///
    /// Selected rather than filtered afterwards: `ended_at IS NULL` is in the
    /// predicate, so somebody who left cannot reach a roster through this path
    /// even if the layer above forgot to check.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or a stored row cannot be read.
    pub async fn active_session_memberships(
        &self,
        session_id: SessionId,
    ) -> anyhow::Result<Vec<SessionMembership>> {
        let rows = sqlx::query(
            "SELECT * FROM session_memberships \
             WHERE session_id = ?1 AND ended_at IS NULL ORDER BY admitted_at",
        )
        .bind(session_id.to_string())
        .fetch_all(&self.pool)
        .await
        .context("select session roster")?;
        rows.iter().map(stored_membership).collect()
    }

    /// How many live grants one member still holds, at `now`.
    ///
    /// The number [`SessionMembership::lowered_to_observer`] is given. Counted
    /// in SQL because the caller only needs to know whether it is zero, and
    /// reconstructing every grant to find that out would read row scopes
    /// nobody asked for.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn live_grant_count(
        &self,
        session_id: SessionId,
        subject_principal_id: PrincipalId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<usize> {
        let row = sqlx::query(
            "SELECT COUNT(*) AS held FROM session_grants \
             WHERE session_id = ?1 AND subject_principal_id = ?2 \
             AND revoked_at IS NULL AND expires_at > ?3",
        )
        .bind(session_id.to_string())
        .bind(subject_principal_id.to_string())
        .bind(now.to_rfc3339())
        .fetch_one(&self.pool)
        .await
        .context("count live grants")?;
        let held: i64 = row.get("held");
        Ok(usize::try_from(held).unwrap_or(usize::MAX))
    }

    /// End a session: shut it, empty the room, and take back what it lent.
    ///
    /// One transaction, in this order, because the intermediate states are all
    /// wrong in the same direction — a session marked closed whose grants
    /// still authorize is exactly the window an operator closing a session is
    /// trying to shut.
    ///
    /// **Only `lifecycle_bound` grants are revoked.** A `referenced` grant is
    /// a narrowed pointer at reach the holder has by another road; revoking it
    /// here would mean that ending a meeting silently withdrew somebody's
    /// project access, and that the pointer — which is supposed to be the
    /// *safe* kind of link — was the dangerous one. The `revoked_at IS NULL`
    /// predicate keeps the revocation one-way and idempotent, exactly as the
    /// single-grant path does.
    ///
    /// Returns whether this call was the one that closed it. A second close is
    /// `false` rather than an error: the caller's intent is satisfied either
    /// way.
    ///
    /// # Errors
    ///
    /// Returns an error when any of the three writes fails, in which case none
    /// of them lands.
    pub async fn close_session(
        &self,
        organization_id: &str,
        session_id: SessionId,
        now: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let mut transaction = self.pool.begin().await.context("begin close")?;

        let closed = sqlx::query(
            "UPDATE sessions SET closed_at = ?1 \
             WHERE id = ?2 AND organization_id = ?3 AND closed_at IS NULL",
        )
        .bind(now.to_rfc3339())
        .bind(session_id.to_string())
        .bind(organization_id)
        .execute(&mut *transaction)
        .await
        .context("close session")?;

        if closed.rows_affected() != 1 {
            transaction.rollback().await.context("rollback close")?;
            return Ok(false);
        }

        sqlx::query(
            "UPDATE session_grants SET revoked_at = ?1 \
             WHERE session_id = ?2 AND link = 'lifecycle_bound' AND revoked_at IS NULL",
        )
        .bind(now.to_rfc3339())
        .bind(session_id.to_string())
        .execute(&mut *transaction)
        .await
        .context("revoke the session's own grants")?;

        sqlx::query(
            "UPDATE session_memberships SET ended_at = ?1 \
             WHERE session_id = ?2 AND ended_at IS NULL",
        )
        .bind(now.to_rfc3339())
        .bind(session_id.to_string())
        .execute(&mut *transaction)
        .await
        .context("end the session's seats")?;

        transaction.commit().await.context("commit close")?;
        Ok(true)
    }
}
