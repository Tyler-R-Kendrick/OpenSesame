//! Durable Host authorization ceiling for secret-configuration metadata.
//! Identity evidence may narrow this policy, but cannot create or raise it.
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectAccess {
    pub metadata_read: bool,
    pub keys_read: bool,
}

#[derive(Clone, Copy)]
pub enum ResourcePermission {
    Metadata,
    Keys,
    Manage,
}

pub enum PolicyActor {
    Operator,
    Session {
        principal: PrincipalId,
        role: OrganizationRole,
    },
}

#[derive(Serialize)]
pub struct RolePolicy {
    pub role: Option<OrganizationRole>,
    pub revision: u64,
    pub evidence_after: i64,
}

/// Native policy inspection for optimistic updates; not a public directory.
/// # Errors
/// Returns database failures or corrupt revision metadata.
pub async fn role_policy(
    pool: &SqlitePool,
    organization: &OrganizationId,
    principal: &PrincipalId,
) -> anyhow::Result<Option<RolePolicy>> {
    let row = sqlx::query("SELECT role,revision,evidence_after FROM config_authorization_roles WHERE organization_id=? AND principal_id=?")
        .bind(organization.to_string()).bind(principal.to_string()).fetch_optional(pool).await?;
    row.map(|row| {
        Ok(RolePolicy {
            role: parse_role(row.get::<Option<&str>, _>("role")),
            revision: u64::try_from(row.get::<i64, _>("revision"))?,
            evidence_after: row.get("evidence_after"),
        })
    })
    .transpose()
}

fn rank(role: OrganizationRole) -> u8 {
    match role {
        OrganizationRole::Owner => 3,
        OrganizationRole::Admin => 2,
        OrganizationRole::Member => 1,
    }
}

/// Initialize policy only during explicit native approval. Existing ceilings,
/// including revocations, are never raised by another login or pairing.
/// # Errors
/// Returns database failures. Concurrent first approvals use the stored winner.
pub async fn provision_native_role(
    pool: &SqlitePool,
    organization: &OrganizationId,
    principal: &PrincipalId,
    role: OrganizationRole,
) -> anyhow::Result<()> {
    if role_policy(pool, organization, principal).await?.is_some() {
        return Ok(());
    }
    if let Err(error) = set_role_ceiling(pool, organization, principal, Some(role), 0, 0).await {
        if role_policy(pool, organization, principal).await?.is_none() {
            return Err(error);
        }
    }
    Ok(())
}
fn role_text(role: OrganizationRole) -> &'static str {
    match role {
        OrganizationRole::Owner => "owner",
        OrganizationRole::Admin => "admin",
        OrganizationRole::Member => "member",
    }
}
fn parse_role(raw: Option<&str>) -> Option<OrganizationRole> {
    match raw {
        Some("owner") => Some(OrganizationRole::Owner),
        Some("admin") => Some(OrganizationRole::Admin),
        Some("member") => Some(OrganizationRole::Member),
        _ => None,
    }
}

/// Evaluate the current stored ceiling on every request. No session populates it.
/// # Errors
/// Returns database failures; callers must refuse access.
pub async fn permits(
    pool: &SqlitePool,
    organization: &OrganizationId,
    actor: &PolicyActor,
    project: &str,
    permission: ResourcePermission,
) -> anyhow::Result<bool> {
    let PolicyActor::Session { principal, role } = actor else {
        return Ok(true);
    };
    let row = sqlx::query("SELECT r.role, p.metadata_read, p.keys_read FROM config_authorization_roles r LEFT JOIN config_project_access p ON p.organization_id=r.organization_id AND p.principal_id=r.principal_id AND p.project_id=? WHERE r.organization_id=? AND r.principal_id=?")
        .bind(project).bind(organization.to_string()).bind(principal.to_string()).fetch_optional(pool).await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let Some(ceiling) = parse_role(row.get::<Option<&str>, _>("role")) else {
        return Ok(false);
    };
    if rank(ceiling).min(rank(*role)) >= 2 {
        return Ok(true);
    }
    Ok(match permission {
        ResourcePermission::Manage => false,
        ResourcePermission::Metadata => row.get::<Option<bool>, _>("metadata_read") == Some(true),
        ResourcePermission::Keys => {
            row.get::<Option<bool>, _>("metadata_read") == Some(true)
                && row.get::<Option<bool>, _>("keys_read") == Some(true)
        }
    })
}

/// Explicit native operator provisioning/update. `expected_revision=0` creates
/// a new ceiling; an existing ceiling is never overwritten by initial minting.
/// # Errors
/// Refuses stale policy revisions, negative evidence fences and database failures.
pub async fn set_role_ceiling(
    pool: &SqlitePool,
    organization: &OrganizationId,
    principal: &PrincipalId,
    role: Option<OrganizationRole>,
    expected_revision: u64,
    evidence_after: i64,
) -> anyhow::Result<u64> {
    anyhow::ensure!(evidence_after >= 0, "invalid authorization evidence fence");
    let revision = i64::try_from(expected_revision)?;
    let next = revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("policy revision exhausted"))?;
    let mut tx = pool.begin().await?;
    let result = if revision == 0 {
        sqlx::query("INSERT OR IGNORE INTO config_authorization_roles (organization_id,principal_id,role,revision,evidence_after) VALUES (?,?,?,1,?)")
            .bind(organization.to_string()).bind(principal.to_string()).bind(role.map(role_text)).bind(evidence_after).execute(&mut *tx).await?
    } else {
        sqlx::query("UPDATE config_authorization_roles SET role=?, revision=?, evidence_after=MAX(evidence_after,?) WHERE organization_id=? AND principal_id=? AND revision=?")
            .bind(role.map(role_text)).bind(next).bind(evidence_after).bind(organization.to_string()).bind(principal.to_string()).bind(revision).execute(&mut *tx).await?
    };
    anyhow::ensure!(
        result.rows_affected() == 1,
        "authorization policy changed; reload revision"
    );
    if role.is_none() {
        sqlx::query("DELETE FROM config_project_access WHERE organization_id=? AND principal_id=?")
            .bind(organization.to_string())
            .bind(principal.to_string())
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO outbox_events(id,event_type,payload_json,created_at) VALUES(?,?,?,?)")
        .bind(uuid::Uuid::now_v7().to_string()).bind("config.authorization.role_changed")
        .bind(serde_json::json!({"organization_id":organization.to_string(),"principal_id":principal.to_string(),"revision":next}).to_string())
        .bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(u64::try_from(next)?)
}

/// Set explicit project permissions after checking the manager's current ceiling.
/// # Errors
/// Refuses a stale/non-admin manager, nonexistent membership and invalid capabilities.
pub async fn set_project_access(
    pool: &SqlitePool,
    organization: &OrganizationId,
    actor: &PolicyActor,
    project: &str,
    principal: &PrincipalId,
    access: ProjectAccess,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !project.is_empty() && project.len() <= 128 && (!access.keys_read || access.metadata_read),
        "invalid project capability policy"
    );
    let mut tx = pool.begin().await?;
    if let PolicyActor::Session { principal, role } = actor {
        let ceiling: Option<String> = sqlx::query_scalar("SELECT role FROM config_authorization_roles WHERE organization_id=? AND principal_id=?")
            .bind(organization.to_string()).bind(principal.to_string()).fetch_optional(&mut *tx).await?.flatten();
        anyhow::ensure!(
            parse_role(ceiling.as_deref())
                .is_some_and(|current| rank(current).min(rank(*role)) >= 2),
            "policy management denied"
        );
    }
    let current: Option<String> = sqlx::query_scalar(
        "SELECT role FROM config_authorization_roles WHERE organization_id=? AND principal_id=?",
    )
    .bind(organization.to_string())
    .bind(principal.to_string())
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    anyhow::ensure!(
        parse_role(current.as_deref()).is_some(),
        "project principal has no active Host membership"
    );
    sqlx::query("INSERT INTO config_project_access (organization_id,project_id,principal_id,metadata_read,keys_read) VALUES (?,?,?,?,?) ON CONFLICT(organization_id,project_id,principal_id) DO UPDATE SET metadata_read=excluded.metadata_read,keys_read=excluded.keys_read")
        .bind(organization.to_string()).bind(project).bind(principal.to_string()).bind(access.metadata_read).bind(access.keys_read).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO outbox_events(id,event_type,payload_json,created_at) VALUES(?,?,?,?)")
        .bind(uuid::Uuid::now_v7().to_string()).bind("config.authorization.project_changed")
        .bind(serde_json::json!({"organization_id":organization.to_string(),"project_id":project,"principal_id":principal.to_string(),"metadata_read":access.metadata_read,"keys_read":access.keys_read}).to_string())
        .bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
