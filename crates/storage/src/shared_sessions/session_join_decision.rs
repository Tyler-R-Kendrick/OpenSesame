//! Admissions, seats and grants share the writer lock with closure.
use super::decision_str;
use crate::Db;
use anyhow::{bail, Context};
use chrono::{DateTime, Utc};
use opensesame_domain::{
    Admission, JoinDecision, JoinRequestId, PrincipalId, SessionGrant, SessionGrantId,
    SessionMembership,
};

#[derive(Debug)]
pub struct ClosedOrDecided;
impl std::fmt::Display for ClosedOrDecided {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("request is not pending in an open session")
    }
}
impl std::error::Error for ClosedOrDecided {}

#[derive(Debug)]
pub struct SessionClosed;
impl std::fmt::Display for SessionClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("session is closed or missing")
    }
}
impl std::error::Error for SessionClosed {}

fn decision_shape(
    decision: JoinDecision,
    minted: Option<&SessionGrant>,
) -> anyhow::Result<(Option<&'static str>, Option<SessionGrantId>)> {
    Ok(match decision {
        JoinDecision::Pending => {
            bail!("deciding a request to 'pending' is not a decision")
        }
        JoinDecision::Admitted {
            admission: Admission::Participant { grant_id },
        } => match minted {
            Some(grant) if grant.id == grant_id => (Some("participant"), Some(grant_id)),
            _ => bail!("admitting a participant must carry the grant it mints"),
        },
        JoinDecision::Admitted {
            admission: Admission::Observer,
        } => {
            // The seat that holds nothing. A grant alongside it would be a
            // key wrapped for somebody the operator said needs none, and
            // ADR 0079 §3 cannot take that back.
            if minted.is_some() {
                bail!("admitting an observer must not mint a grant");
            }
            (Some("observer"), None)
        }
        JoinDecision::Refused => {
            if minted.is_some() {
                bail!("a refusal must not carry a grant");
            }
            (None, None)
        }
    })
}

impl Db {
    /// Decide and seat atomically, refusing every decision after closure.
    ///
    /// # Errors
    /// Returns an error for closed or decided requests, mismatched grants, or failed writes.
    pub async fn decide_join_request(
        &self,
        organization_id: &str,
        request_id: JoinRequestId,
        decision: JoinDecision,
        decided_by: PrincipalId,
        decided_at: DateTime<Utc>,
        minted: Option<&SessionGrant>,
    ) -> anyhow::Result<()> {
        let (admitted_mode, grant_id) = decision_shape(decision, minted)?;

        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .context("begin decision")?;
        let row = sqlx::query("SELECT r.* FROM session_join_requests r JOIN sessions s ON s.id = r.session_id AND s.organization_id = r.organization_id WHERE r.id = ?1 AND r.organization_id = ?2 AND r.decision = 'pending' AND s.closed_at IS NULL")
            .bind(request_id.to_string()).bind(organization_id)
            .fetch_optional(&mut *transaction).await.context("read pending admission")?
            .ok_or(ClosedOrDecided)?;
        let request = super::stored_join_request(&row)?;
        if let Some(grant) = minted {
            if grant.session_id != request.session_id
                || grant.subject_principal_id != request.requester_principal_id
            {
                bail!("admission grant does not match the request");
            }
        }

        if let Some(grant) = minted {
            // Written inside the same transaction as the decision, so a
            // partial failure cannot leave an admitted request pointing at a
            // grant that does not exist.
            self.insert_grant_in(&mut transaction, organization_id, grant)
                .await?;
        }

        // `decision = 'pending'` in the predicate is the guard: a request that
        // has already been decided is not decided again, and the audit trail
        // cannot be edited in place. A later ask is a new row.
        let result = sqlx::query(
            "UPDATE session_join_requests \
             SET decision = ?1, decided_at = ?2, decided_by_principal_id = ?3, \
             admitted_mode = ?4, grant_id = ?5 \
             WHERE id = ?6 AND organization_id = ?7 AND decision = 'pending'",
        )
        .bind(decision_str(decision))
        .bind(decided_at.to_rfc3339())
        .bind(decided_by.to_string())
        .bind(admitted_mode)
        .bind(grant_id.map(|id| id.to_string()))
        .bind(request_id.to_string())
        .bind(organization_id)
        .execute(&mut *transaction)
        .await
        .context("decide join request")?;

        if result.rows_affected() != 1 {
            bail!("join request is not pending");
        }

        if let JoinDecision::Admitted { admission } = decision {
            let seat = SessionMembership::new(
                request.session_id,
                request.requester_principal_id,
                admission.mode(),
                decided_by,
                decided_at,
            );
            self.upsert_session_membership_in(&mut transaction, organization_id, &seat)
                .await?;
        }
        transaction.commit().await.context("commit decision")?;
        Ok(())
    }
}
