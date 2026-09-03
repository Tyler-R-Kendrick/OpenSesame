//! Organizations, projects and the authority quorum setting.
//!
//! Split out of the single `impl Db` block in `lib.rs`, which had grown to
//! 215 methods across 5,292 lines. Rust spreads a type's inherent impl over
//! any number of modules in the same crate, so this is a pure move: no
//! signature, visibility or call site changes.

use super::{Db, OrganizationId, ProjectId, Row, Utc};

impl Db {
    /// Report whether the authority is both quorate and unsealed.
    ///
    /// # Errors
    ///
    /// Returns an error when authority health cannot be queried.
    pub async fn authority_quorum_ok(&self) -> anyhow::Result<bool> {
        let row = sqlx::query("SELECT quorum_ok, sealed FROM authority_health WHERE id = 1")
            .fetch_one(&self.pool)
            .await?;
        let quorum_ok: i64 = row.get("quorum_ok");
        let sealed: i64 = row.get("sealed");
        Ok(quorum_ok == 1 && sealed == 0)
    }

    /// Update the persisted authority quorum state.
    ///
    /// # Errors
    ///
    /// Returns an error when the health row cannot be updated.
    pub async fn set_authority_quorum(&self, ok: bool) -> anyhow::Result<()> {
        sqlx::query("UPDATE authority_health SET quorum_ok = ?, updated_at = ? WHERE id = 1")
            .bind(i32::from(ok))
            .bind(Utc::now().to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Persist a new organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the organization violates database constraints or
    /// cannot be inserted.
    pub async fn create_organization(&self, id: &OrganizationId, name: &str) -> anyhow::Result<()> {
        sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(id.to_string())
            .bind(name)
            .bind(Utc::now().to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Persist a project belonging to an organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the organization is absent, constraints fail, or
    /// the project cannot be inserted.
    pub async fn create_project(
        &self,
        id: &ProjectId,
        org: &OrganizationId,
        name: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO projects (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(org.to_string())
        .bind(name)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // —— certificate policies ——————————————————————————————————————
}
