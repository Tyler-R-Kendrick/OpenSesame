//! Projections and the writer topology, stated rather than assumed.
//!
//! A projection — `OpenFGA` tuples, an Identity mirror, a browser cache, a
//! `NATS` consumer — is never the ledger of current authority. It records two
//! numbers: the revision the authority committed, and the revision the
//! projection has actually applied. `projection_applied` answers the only
//! question a caller may ask of it: *has this store caught up to the revision my
//! decision depends on?* Unknown is not yes. A dirty projection cannot satisfy a
//! freshness fence, and a revoke denies at the authority fence while cleanup is
//! still pending.
//!
//! The writer topology is one lease and one fence token. This is a single-writer
//! store; it does not become a quorum because two processes opened it. A writer
//! that lost the lease is refused by `assert_writer_lease` rather than left to
//! interleave with the writer that holds it.

use crate::{append_outbox_tx, Db, Row, Utc};

/// A projection subject and the authority revision at issue.
pub struct ProjectionMark<'a> {
    pub store: &'a str,
    pub organization_id: &'a str,
    pub subject_kind: &'a str,
    pub subject_id: &'a str,
    pub committed_revision: i64,
}

/// A held writer lease. `fence_token` rises on every takeover, so a resumed
/// writer's token is recognisably stale.
#[derive(Debug, PartialEq, Eq)]
pub struct WriterLease {
    pub writer_id: String,
    pub fence_token: i64,
}

impl Db {
    /// Record that a projection owes work up to `committed_revision`.
    ///
    /// # Errors
    ///
    /// Returns an error when the upsert or its outbox event cannot commit.
    pub async fn mark_projection_dirty(&self, mark: &ProjectionMark<'_>) -> anyhow::Result<()> {
        anyhow::ensure!(
            mark.committed_revision > 0,
            "a committed revision starts at 1"
        );
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        sqlx::query(
            "INSERT INTO authority_projections \
             (store, organization_id, subject_kind, subject_id, committed_revision, \
              applied_revision, dirty_since, updated_at) \
             VALUES (?, ?, ?, ?, ?, 0, ?, ?) \
             ON CONFLICT (store, organization_id, subject_kind, subject_id) DO UPDATE SET \
               committed_revision = MAX(committed_revision, excluded.committed_revision), \
               dirty_since = COALESCE(dirty_since, excluded.dirty_since), \
               updated_at = excluded.updated_at",
        )
        .bind(mark.store)
        .bind(mark.organization_id)
        .bind(mark.subject_kind)
        .bind(mark.subject_id)
        .bind(mark.committed_revision)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        append_outbox_tx(
            &mut tx,
            "authority.projection.dirty",
            &serde_json::json!({
                "store": mark.store,
                "organization_id": mark.organization_id,
                "subject_kind": mark.subject_kind,
                "subject_id": mark.subject_id,
                "committed_revision": mark.committed_revision,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Record that a projection applied an authority revision.
    ///
    /// Refuses to move `applied_revision` backwards, and refuses to claim a
    /// revision the authority never committed — a projection that could report
    /// itself ahead of the ledger would let a grant activate from a state no
    /// approval produced. The `model_id` is stored beside it because a tuple
    /// applied under a different authorization model is not the same fact.
    ///
    /// # Errors
    ///
    /// Returns an error when the update cannot be written.
    pub async fn record_projection_applied(
        &self,
        mark: &ProjectionMark<'_>,
        model_id: Option<&str>,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().to_rfc3339();
        let changed = sqlx::query(
            "UPDATE authority_projections \
             SET applied_revision = ?, model_id = ?, last_error = NULL, \
                 dirty_since = CASE WHEN ? >= committed_revision THEN NULL ELSE dirty_since END, \
                 updated_at = ? \
             WHERE store = ? AND organization_id = ? AND subject_kind = ? AND subject_id = ? \
               AND applied_revision < ? AND ? <= committed_revision",
        )
        .bind(mark.committed_revision)
        .bind(model_id)
        .bind(mark.committed_revision)
        .bind(&now)
        .bind(mark.store)
        .bind(mark.organization_id)
        .bind(mark.subject_kind)
        .bind(mark.subject_id)
        .bind(mark.committed_revision)
        .bind(mark.committed_revision)
        .execute(self.pool())
        .await?
        .rows_affected();
        Ok(changed == 1)
    }

    /// Record that a projection attempt failed, leaving it dirty.
    ///
    /// # Errors
    ///
    /// Returns an error when the update cannot be written.
    pub async fn record_projection_error(
        &self,
        mark: &ProjectionMark<'_>,
        error: &str,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().to_rfc3339();
        let changed = sqlx::query(
            "UPDATE authority_projections \
             SET last_error = ?, dirty_since = COALESCE(dirty_since, ?), updated_at = ? \
             WHERE store = ? AND organization_id = ? AND subject_kind = ? AND subject_id = ?",
        )
        .bind(error)
        .bind(&now)
        .bind(&now)
        .bind(mark.store)
        .bind(mark.organization_id)
        .bind(mark.subject_kind)
        .bind(mark.subject_id)
        .execute(self.pool())
        .await?
        .rows_affected();
        Ok(changed == 1)
    }

    /// Has this projection applied at least `committed_revision`, under the
    /// authorization model the caller requires?
    ///
    /// A subject with no row answers `false`: an absent projection is unknown
    /// state, and unknown required state denies.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn projection_applied(
        &self,
        mark: &ProjectionMark<'_>,
        required_model_id: Option<&str>,
    ) -> anyhow::Result<bool> {
        let row = sqlx::query(
            "SELECT applied_revision, model_id FROM authority_projections \
             WHERE store = ? AND organization_id = ? AND subject_kind = ? AND subject_id = ?",
        )
        .bind(mark.store)
        .bind(mark.organization_id)
        .bind(mark.subject_kind)
        .bind(mark.subject_id)
        .fetch_optional(self.pool())
        .await?;
        let Some(row) = row else { return Ok(false) };
        if row.get::<i64, _>("applied_revision") < mark.committed_revision {
            return Ok(false);
        }
        match required_model_id {
            None => Ok(true),
            Some(required) => {
                let applied: Option<String> = row.try_get("model_id")?;
                Ok(applied.as_deref() == Some(required))
            }
        }
    }

    /// Take or renew the single writer lease.
    ///
    /// Returns `None` while another writer holds an unexpired lease. The token
    /// rises on every takeover, so the previous holder's token is stale from that
    /// moment and `assert_writer_lease` refuses it.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn acquire_writer_lease(
        &self,
        writer_id: &str,
        lease_seconds: i64,
    ) -> anyhow::Result<Option<WriterLease>> {
        anyhow::ensure!(lease_seconds > 0, "a lease must have a duration");
        let now = Utc::now();
        let expires = now + chrono::Duration::seconds(lease_seconds);
        let mut tx = self.pool().begin().await?;
        let current = sqlx::query(
            "SELECT writer_id, fence_token, expires_at FROM authority_writer_lease WHERE id = 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let token = match current {
            None => 1,
            Some(row) => {
                let holder: String = row.try_get("writer_id")?;
                let held_until: String = row.try_get("expires_at")?;
                let live = chrono::DateTime::parse_from_rfc3339(&held_until)
                    .is_ok_and(|at| at.with_timezone(&Utc) > now);
                if live && holder != writer_id {
                    return Ok(None);
                }
                row.get::<i64, _>("fence_token") + i64::from(holder != writer_id)
            }
        };
        sqlx::query(
            "INSERT INTO authority_writer_lease \
             (id, writer_id, fence_token, expires_at, updated_at) VALUES (1, ?, ?, ?, ?) \
             ON CONFLICT (id) DO UPDATE SET writer_id = excluded.writer_id, \
               fence_token = excluded.fence_token, expires_at = excluded.expires_at, \
               updated_at = excluded.updated_at",
        )
        .bind(writer_id)
        .bind(token)
        .bind(expires.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(WriterLease {
            writer_id: writer_id.to_owned(),
            fence_token: token,
        }))
    }

    /// Refuse a writer that no longer holds the lease it thinks it holds.
    ///
    /// # Errors
    ///
    /// Returns an error when the lease is absent, held by another writer, expired,
    /// or carries a newer fence token — each of which means this process must not
    /// write.
    pub async fn assert_writer_lease(&self, lease: &WriterLease) -> anyhow::Result<()> {
        let row = sqlx::query(
            "SELECT writer_id, fence_token, expires_at FROM authority_writer_lease WHERE id = 1",
        )
        .fetch_optional(self.pool())
        .await?
        .ok_or_else(|| anyhow::anyhow!("no writer holds the authority lease"))?;
        let holder: String = row.try_get("writer_id")?;
        let token: i64 = row.try_get("fence_token")?;
        let expires: String = row.try_get("expires_at")?;
        anyhow::ensure!(
            holder == lease.writer_id && token == lease.fence_token,
            "authority writer lease is held by {holder} at fence {token}"
        );
        let held_until = chrono::DateTime::parse_from_rfc3339(&expires)?.with_timezone(&Utc);
        anyhow::ensure!(held_until > Utc::now(), "authority writer lease expired");
        Ok(())
    }
}
