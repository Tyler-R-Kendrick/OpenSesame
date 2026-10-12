//! Explicit, durable authority for sync egress, including actor retries.
//!
//! A target is not executable until its grant is persisted. Legacy targets
//! without a grant fail closed and must be recreated by an authorized caller.

use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use sqlx::Row;

use crate::config_access::{self, PolicyActor, ResourcePermission};
use crate::error::{BrokerError, Result};
use crate::store::SyncTargetRow;
use crate::sync_target::{CreateSyncTarget, SyncTargetView};
use crate::ConnectionBroker;

fn policy_error(_: anyhow::Error) -> BrokerError {
    BrokerError::Storage(sqlx::Error::Protocol(
        "sync authorization lookup failed".into(),
    ))
}

fn role_name(role: OrganizationRole) -> &'static str {
    match role {
        OrganizationRole::Owner => "owner",
        OrganizationRole::Admin => "admin",
        OrganizationRole::Member => "member",
    }
}

impl ConnectionBroker {
    async fn ensure_sync_authority_schema(&self) -> Result<()> {
        // Sync-target storage uses lazy, additive schema initialization too.
        // No backfill: absence must never imply native/operator authority.
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS sync_target_authority (
                target_id TEXT PRIMARY KEY NOT NULL,
                organization_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                config_id TEXT NOT NULL,
                actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator','session')),
                principal_id TEXT,
                session_role TEXT,
                role_revision INTEGER,
                CHECK (
                    (actor_kind='operator' AND principal_id IS NULL
                        AND session_role IS NULL AND role_revision IS NULL)
                    OR (actor_kind='session' AND principal_id IS NOT NULL
                        AND session_role IN ('owner','admin','member')
                        AND role_revision IS NOT NULL AND role_revision > 0)
                )
            )",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Native Host-only creation, retaining the existing internal API.
    /// Session-facing adapters MUST use `create_sync_target_for_actor` instead.
    /// The native grant is explicit in storage; it is never inferred at read time.
    ///
    /// # Errors
    /// Returns validation, authorization, or storage failures.
    pub async fn create_sync_target(
        &self,
        organization_id: &OrganizationId,
        request: CreateSyncTarget,
    ) -> Result<SyncTargetView> {
        self.create_sync_target_for_actor(organization_id, request, &PolicyActor::Operator)
            .await
    }

    /// Create a target with the caller's durable, revocable delegation.
    /// A role revision change invalidates the delegation, even if a later role
    /// update restores privileges. Recreate the target to approve a new grant.
    ///
    /// # Errors
    /// Refuses absent/revoked authority and fails closed on policy/store errors.
    pub async fn create_sync_target_for_actor(
        &self,
        organization_id: &OrganizationId,
        request: CreateSyncTarget,
        actor: &PolicyActor,
    ) -> Result<SyncTargetView> {
        let project = request.project_id.trim();
        for permission in [ResourcePermission::Manage, ResourcePermission::Keys] {
            if !config_access::permits(&self.pool, organization_id, actor, project, permission)
                .await
                .map_err(policy_error)?
            {
                return Err(BrokerError::SyncTargetNotFound);
            }
        }
        self.ensure_sync_authority_schema().await?;
        let (kind, principal, role, revision) = match actor {
            PolicyActor::Operator => ("operator", None, None, None),
            PolicyActor::Session { principal, role } => {
                let policy = config_access::role_policy(&self.pool, organization_id, principal)
                    .await
                    .map_err(policy_error)?
                    .ok_or(BrokerError::SyncTargetNotFound)?;
                let revision = i64::try_from(policy.revision)
                    .map_err(|_| BrokerError::SyncTargetNotFound)?;
                (
                    "session",
                    Some(principal.to_string()),
                    Some(role_name(*role)),
                    Some(revision),
                )
            }
        };
        // A concurrently discovered target is denied until the grant exists.
        let target = self.insert_sync_target_unapproved(organization_id, request).await?;
        let grant = sqlx::query(
            "INSERT INTO sync_target_authority
                (target_id,organization_id,project_id,config_id,actor_kind,
                 principal_id,session_role,role_revision) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&target.id)
        .bind(organization_id.to_string())
        .bind(&target.project_id)
        .bind(&target.config_id)
        .bind(kind)
        .bind(principal)
        .bind(role)
        .bind(revision)
        .execute(&self.pool)
        .await;
        if let Err(error) = grant {
            let _ = self.delete_sync_target(organization_id, &target.id).await;
            return Err(error.into());
        }
        let row = self.sync_target_in_org(organization_id, &target.id).await?;
        if let Err(error) = self.require_sync_target_authority(organization_id, &row).await {
            let _ = self.delete_sync_target(organization_id, &target.id).await;
            return Err(error);
        }
        Ok(target)
    }

    pub(super) async fn require_sync_target_authority(
        &self,
        organization_id: &OrganizationId,
        target: &SyncTargetRow,
    ) -> Result<()> {
        self.ensure_sync_authority_schema().await?;
        let grant = sqlx::query(
            "SELECT actor_kind,principal_id,session_role,role_revision
             FROM sync_target_authority
             WHERE target_id=? AND organization_id=? AND project_id=? AND config_id=?",
        )
        .bind(&target.id)
        .bind(organization_id.to_string())
        .bind(&target.project_id)
        .bind(&target.config_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(BrokerError::SyncTargetNotFound)?;
        let kind: String = grant.try_get("actor_kind")?;
        if kind == "operator" {
            return Ok(());
        }
        if kind != "session" {
            return Err(BrokerError::SyncTargetNotFound);
        }
        let principal: String = grant.try_get("principal_id")?;
        let principal = PrincipalId::parse(&principal)
            .map_err(|_| BrokerError::SyncTargetNotFound)?;
        let role: String = grant.try_get("session_role")?;
        let role = match role.as_str() {
            "owner" => OrganizationRole::Owner,
            "admin" => OrganizationRole::Admin,
            "member" => OrganizationRole::Member,
            _ => return Err(BrokerError::SyncTargetNotFound),
        };
        let revision: i64 = grant.try_get("role_revision")?;
        let policy = config_access::role_policy(&self.pool, organization_id, &principal)
            .await
            .map_err(policy_error)?
            .ok_or(BrokerError::SyncTargetNotFound)?;
        if u64::try_from(revision).ok() != Some(policy.revision) {
            return Err(BrokerError::SyncTargetNotFound);
        }
        let actor = PolicyActor::Session { principal, role };
        for permission in [ResourcePermission::Manage, ResourcePermission::Keys] {
            if !config_access::permits(
                &self.pool,
                organization_id,
                &actor,
                &target.project_id,
                permission,
            )
            .await
            .map_err(policy_error)?
            {
                return Err(BrokerError::SyncTargetNotFound);
            }
        }
        Ok(())
    }

    pub(super) async fn remove_sync_target_authority(&self, id: &str) -> Result<()> {
        self.ensure_sync_authority_schema().await?;
        sqlx::query("DELETE FROM sync_target_authority WHERE target_id=?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
