//! Certificate approval policies and their ordered steps.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{
    now_rfc3339, stored_approval_policy, stored_approval_step, validate_json_document,
    ApprovalStepOutcome, Context, Db, Role, Row, StoredApprovalPolicy, StoredApprovalStep,
};

impl Db {
    /// Resolve a subject's effective role on an application.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn effective_app_role(
        &self,
        organization_id: &str,
        application_id: &str,
        subject: &str,
    ) -> anyhow::Result<Option<Role>> {
        let row = sqlx::query(
            "SELECT role FROM pki_application_members WHERE organization_id = ? AND application_id = ? AND subject = ?",
        )
        .bind(organization_id)
        .bind(application_id)
        .bind(subject)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| Role::from_application_str(&row.get::<String, _>("role"))))
    }

    // —— enrollment configuration ——————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `covers_json` is malformed or the insert fails.
    pub async fn insert_approval_policy(
        &self,
        policy: &StoredApprovalPolicy,
    ) -> anyhow::Result<()> {
        validate_json_document(&policy.covers_json, "approval policy coverage")?;
        self.ensure_organization_row(&policy.organization_id, &policy.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO approval_policies (id, organization_id, scope, application_id, signer_id, name, max_request_ttl_seconds, machine_bypass, covers_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&policy.id)
        .bind(&policy.organization_id)
        .bind(&policy.scope)
        .bind(&policy.application_id)
        .bind(&policy.signer_id)
        .bind(&policy.name)
        .bind(policy.max_request_ttl_seconds)
        .bind(i64::from(policy.machine_bypass))
        .bind(&policy.covers_json)
        .bind(policy.version)
        .bind(&policy.created_at)
        .bind(&policy.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_approval_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<Option<StoredApprovalPolicy>> {
        let row =
            sqlx::query("SELECT * FROM approval_policies WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(policy_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_approval_policy))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_approval_policies(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredApprovalPolicy>> {
        let rows = sqlx::query(
            "SELECT * FROM approval_policies WHERE organization_id = ? ORDER BY name, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_approval_policy).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_approval_policy(
        &self,
        policy: &StoredApprovalPolicy,
    ) -> anyhow::Result<bool> {
        validate_json_document(&policy.covers_json, "approval policy coverage")?;
        let result = sqlx::query(
            "UPDATE approval_policies SET name = ?, max_request_ttl_seconds = ?, machine_bypass = ?, covers_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&policy.name)
        .bind(policy.max_request_ttl_seconds)
        .bind(i64::from(policy.machine_bypass))
        .bind(&policy.covers_json)
        .bind(now_rfc3339())
        .bind(&policy.organization_id)
        .bind(&policy.id)
        .bind(policy.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_approval_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM approval_policies WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(policy_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when `approvers_json` is malformed or the insert fails.
    pub async fn insert_approval_step(&self, step: &StoredApprovalStep) -> anyhow::Result<()> {
        validate_json_document(&step.approvers_json, "approval step approvers")?;
        sqlx::query(
            "INSERT INTO approval_steps (id, organization_id, policy_id, seq, name, approvers_json, required_count, notify, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&step.id)
        .bind(&step.organization_id)
        .bind(&step.policy_id)
        .bind(step.seq)
        .bind(&step.name)
        .bind(&step.approvers_json)
        .bind(step.required_count)
        .bind(i64::from(step.notify))
        .bind(step.version)
        .bind(&step.created_at)
        .bind(&step.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_steps_for_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<Vec<StoredApprovalStep>> {
        let rows = sqlx::query(
            "SELECT * FROM approval_steps WHERE organization_id = ? AND policy_id = ? ORDER BY seq",
        )
        .bind(organization_id)
        .bind(policy_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_approval_step).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_approval_step(
        &self,
        organization_id: &str,
        step_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM approval_steps WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(step_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Advance an open request to the next approval step.
    ///
    /// # Errors
    ///
    /// Returns an error when the request is absent, closed, or not on
    /// `from_step`.
    pub async fn advance_approval_step(
        &self,
        organization_id: &str,
        request_id: &str,
        from_step: i64,
    ) -> anyhow::Result<i64> {
        let result = sqlx::query(
            "UPDATE approval_requests SET current_step = current_step + 1, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = 'open' AND current_step = ?",
        )
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(from_step)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("approval request is not open on the expected step");
        }
        Ok(from_step + 1)
    }

    /// Attach the artifact an approved request produced.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn set_approval_result(
        &self,
        organization_id: &str,
        request_id: &str,
        result_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE approval_requests SET result_id = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(result_id)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Evaluate the request's current step against the decisions recorded for
    /// it. A single rejection is terminal; otherwise the step is satisfied once
    /// distinct approvers reach the step's `required_count`.
    ///
    /// # Errors
    ///
    /// Returns an error when the request or its current step is absent from the
    /// organization, or when a query fails.
    pub async fn approval_step_outcome(
        &self,
        organization_id: &str,
        request_id: &str,
    ) -> anyhow::Result<ApprovalStepOutcome> {
        let request = self
            .get_approval_request(organization_id, request_id)
            .await?
            .context("approval request is not in this organization")?;
        let required = sqlx::query_scalar::<_, i64>(
            "SELECT required_count FROM approval_steps WHERE organization_id = ? AND policy_id = ? AND seq = ?",
        )
        .bind(organization_id)
        .bind(&request.policy_id)
        .bind(request.current_step)
        .fetch_optional(&self.pool)
        .await?
        .context("approval policy has no step at the request's position")?;
        let rejected = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM approval_decisions WHERE organization_id = ? AND request_id = ? AND step_seq = ? AND decision = 'reject'",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(request.current_step)
        .fetch_one(&self.pool)
        .await?;
        if rejected > 0 {
            return Ok(ApprovalStepOutcome::Rejected);
        }
        let approvals = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(DISTINCT approver) FROM approval_decisions WHERE organization_id = ? AND request_id = ? AND step_seq = ? AND decision = 'approve'",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(request.current_step)
        .fetch_one(&self.pool)
        .await?;
        if approvals >= required {
            return Ok(ApprovalStepOutcome::StepSatisfied);
        }
        Ok(ApprovalStepOutcome::Pending)
    }

    // —— code signing ——————————————————————————————————————————————
}
