//! Approval requests and the decisions recorded against them.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, stored_approval_decision, stored_approval_request, validate_json_document, Db,
    StoredApprovalDecision, StoredApprovalRequest,
};

impl Db {
    /// # Errors
    ///
    /// Returns an error when `scope_json` is malformed or the insert fails.
    pub async fn insert_approval_request(
        &self,
        request: &StoredApprovalRequest,
    ) -> anyhow::Result<()> {
        validate_json_document(&request.scope_json, "approval request scope")?;
        sqlx::query(
            "INSERT INTO approval_requests (id, organization_id, policy_id, kind, requester, status, current_step, expires_at, payload_digest, scope_json, result_id, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&request.id)
        .bind(&request.organization_id)
        .bind(&request.policy_id)
        .bind(&request.kind)
        .bind(&request.requester)
        .bind(&request.status)
        .bind(request.current_step)
        .bind(&request.expires_at)
        .bind(&request.payload_digest)
        .bind(&request.scope_json)
        .bind(&request.result_id)
        .bind(request.version)
        .bind(&request.created_at)
        .bind(&request.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_approval_request(
        &self,
        organization_id: &str,
        request_id: &str,
    ) -> anyhow::Result<Option<StoredApprovalRequest>> {
        let row =
            sqlx::query("SELECT * FROM approval_requests WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(request_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_approval_request))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_approval_requests(
        &self,
        organization_id: &str,
        status: Option<&str>,
    ) -> anyhow::Result<Vec<StoredApprovalRequest>> {
        let rows = match status {
            Some(status) => {
                sqlx::query(
                    "SELECT * FROM approval_requests WHERE organization_id = ? AND status = ? ORDER BY created_at, id",
                )
                .bind(organization_id)
                .bind(status)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query(
                    "SELECT * FROM approval_requests WHERE organization_id = ? ORDER BY created_at, id",
                )
                .bind(organization_id)
                .fetch_all(&self.pool)
                .await?
            }
        };
        Ok(rows.iter().map(stored_approval_request).collect())
    }

    /// Compare-and-set the request status, optionally advancing the step and
    /// recording the produced artifact.
    ///
    /// # Errors
    ///
    /// Returns an error when the request is absent from the organization or is
    /// not currently in `from_status`.
    pub async fn transition_approval_request(
        &self,
        organization_id: &str,
        request_id: &str,
        from_status: &str,
        to_status: &str,
    ) -> anyhow::Result<()> {
        let result = sqlx::query(
            "UPDATE approval_requests SET status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = ?",
        )
        .bind(to_status)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(from_status)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("approval request is not in the expected state");
        }
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the insert fails, including a replayed decision
    /// from the same approver on the same step.
    pub async fn insert_approval_decision(
        &self,
        decision: &StoredApprovalDecision,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO approval_decisions (id, organization_id, request_id, step_seq, approver, decision, comment, decided_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&decision.id)
        .bind(&decision.organization_id)
        .bind(&decision.request_id)
        .bind(decision.step_seq)
        .bind(&decision.approver)
        .bind(&decision.decision)
        .bind(&decision.comment)
        .bind(&decision.decided_at)
        .bind(decision.version)
        .bind(&decision.created_at)
        .bind(&decision.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_decisions_for_request(
        &self,
        organization_id: &str,
        request_id: &str,
    ) -> anyhow::Result<Vec<StoredApprovalDecision>> {
        let rows = sqlx::query(
            "SELECT * FROM approval_decisions WHERE organization_id = ? AND request_id = ? ORDER BY step_seq, approver",
        )
        .bind(organization_id)
        .bind(request_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_approval_decision).collect())
    }
}
