//! One durable reply winner. Claim, effect, and terminal state share one transaction.
//! A crash or transient SQL failure rolls everything back, permitting a safe retry.
use crate::Db;
use sqlx::Row;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplyDecision<'a> {
    Acknowledge,
    Cancel {
        run_id: &'a str,
        owner: &'a str,
        valid_until: i64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplyOutcome {
    Applied,
    Duplicate,
    Conflict,
    DeadLetter,
}

#[derive(serde::Serialize)]
pub struct ReplyStatus {
    pub delivery_id: String,
    pub state: String,
    pub outcome: String,
    pub updated_at: String,
}

impl Db {
    /// Bounded, value-blind operator ledger including irrecoverable replies.
    ///
    /// # Errors
    /// Propagates database failures; never hides an unavailable ledger.
    pub async fn list_a2h_reply_status(
        &self,
        organization: &str,
        limit: usize,
    ) -> anyhow::Result<Vec<ReplyStatus>> {
        let rows = sqlx::query(
            "SELECT delivery_id,state,outcome,updated_at FROM a2h_reply_claims
            WHERE organization_id=? ORDER BY updated_at DESC,delivery_id DESC LIMIT ?",
        )
        .bind(organization)
        .bind(i64::try_from(limit.clamp(1, 500))?)
        .fetch_all(self.pool())
        .await?;
        Ok(rows
            .iter()
            .map(|row| ReplyStatus {
                delivery_id: row.get("delivery_id"),
                state: row.get("state"),
                outcome: row.get("outcome"),
                updated_at: row.get("updated_at"),
            })
            .collect())
    }

    /// Apply an already signature-validated response, never outbound delivery status.
    ///
    /// # Errors
    /// Database errors roll back both the claim and effect. No committed applying row
    /// can strand a reply after restart; stale run state is a visible dead letter.
    pub async fn apply_a2h_reply(
        &self,
        delivery: &str,
        organization: &str,
        digest: &str,
        decision: ReplyDecision<'_>,
        now: &str,
    ) -> anyhow::Result<ReplyOutcome> {
        anyhow::ensure!(
            digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid reply digest"
        );
        let (verb, run_id) = match decision {
            ReplyDecision::Acknowledge => ("acknowledge", None),
            ReplyDecision::Cancel { run_id, .. } => ("cancel", Some(run_id)),
        };
        let mut tx = self.pool().begin().await?;
        let inserted = sqlx::query(
            "INSERT INTO a2h_reply_claims
             (delivery_id,organization_id,response_digest,decision,run_id,state,outcome,created_at,updated_at)
             SELECT id,organization_id,?,?,?,'applying','pending',?,?
             FROM security_deliveries WHERE id=? AND organization_id=?
             ON CONFLICT(delivery_id) DO NOTHING")
            .bind(digest).bind(verb).bind(run_id).bind(now).bind(now)
            .bind(delivery).bind(organization).execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            let existing = sqlx::query("SELECT response_digest,state FROM a2h_reply_claims WHERE delivery_id=? AND organization_id=?")
                .bind(delivery).bind(organization).fetch_optional(&mut *tx).await?;
            let outcome = match existing.map(|row| {
                (
                    row.get::<String, _>("response_digest"),
                    row.get::<String, _>("state"),
                )
            }) {
                Some((previous, state)) if previous == digest && state == "applied" => {
                    ReplyOutcome::Duplicate
                }
                Some((previous, _)) if previous == digest => ReplyOutcome::DeadLetter,
                _ => ReplyOutcome::Conflict,
            };
            tx.commit().await?;
            return Ok(outcome);
        }
        let now_unix = chrono::DateTime::parse_from_rfc3339(now)?.timestamp();
        let expired = matches!(decision, ReplyDecision::Cancel { valid_until, .. } if valid_until <= now_unix);
        let applied = match decision {
            ReplyDecision::Acknowledge => true,
            ReplyDecision::Cancel { .. } if expired => false,
            ReplyDecision::Cancel { run_id, owner, .. } => {
                // A stale phone reply cannot interrupt a critical rotation or steal
                // human control. Only the still-parked, owner-bound run may be closed.
                sqlx::query(
                    "UPDATE observation_runs SET control_state='suspended',closed_at=?,
                     blocked_reason='cancelled_by_owner',lease_holder=NULL,lease_expires_at=NULL,
                     handoff_queued=0,version=version+1,updated_at=?
                     WHERE id=? AND organization_id=? AND owner_principal_id=?
                     AND closed_at IS NULL AND quiescence='quiescent'
                     AND control_state IN ('awaiting_human','suspended','handoff_requested')
                     AND NOT EXISTS (SELECT 1 FROM runner_steps WHERE runner_steps.run_id=observation_runs.id
                         AND runner_steps.organization_id=observation_runs.organization_id AND state<>'settled')")
                    .bind(now).bind(now).bind(run_id).bind(organization).bind(owner)
                    .execute(&mut *tx).await?.rows_affected() == 1
            }
        };
        let (state, outcome) = if applied {
            ("applied", "applied")
        } else if expired {
            ("dead_letter", "reply_expired")
        } else {
            ("dead_letter", "run_not_waiting")
        };
        sqlx::query("UPDATE a2h_reply_claims SET state=?,outcome=?,updated_at=? WHERE delivery_id=? AND state='applying'")
            .bind(state).bind(outcome).bind(now).bind(delivery).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(if applied {
            ReplyOutcome::Applied
        } else {
            ReplyOutcome::DeadLetter
        })
    }
}
