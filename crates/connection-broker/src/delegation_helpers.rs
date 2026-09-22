//! Free helpers for [`crate::delegation`]: building the attenuated child
//! grant, the storage-error wrapper, and the organization row a grant's
//! foreign key needs.
//!
//! These are the parts of ADR 0044's claim path that take no `&self`. They sit
//! here rather than at the bottom of `delegation.rs` so that file stays under
//! the module-size budget (ADR 0093); nothing about them changed in the move.

use chrono::{DateTime, Duration, Utc};
use opensesame_domain::{
    grant_budgets::inherit_budgets, Grant, GrantConstraints, GrantId, OfflineUse, PrincipalId,
};

use super::{now_rfc3339, ItemTemplate};
use crate::error::{BrokerError, Result};

pub(super) fn child_grant_from(
    owner: &Grant,
    template: &ItemTemplate,
    now: DateTime<Utc>,
) -> Grant {
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: owner.issuer_principal_id,
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: owner.organization_id,
        project_id: owner.project_id,
        environment_id: None,
        connection_id: owner.connection_id,
        actions: template.actions.clone(),
        resources: template.resources.clone(),
        constraints: GrantConstraints {
            audiences: template.audiences.clone(),
            not_before: None,
            expires_at: (now + Duration::seconds(template.expires_in_seconds))
                .min(owner.constraints.expires_at),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: inherit_budgets(&owner.constraints.budgets, &template.budgets),
            // No re-delegation unless the owner opts in — and the owner
            // ceiling caps it at one hop regardless.
            maximum_delegation_depth: owner.constraints.maximum_delegation_depth,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: Some(owner.id),
        delegation_depth: owner.delegation_depth + 1,
        created_at: now,
        revoked_at: None,
    }
}

pub(super) fn internal<E: std::fmt::Display>(e: E) -> BrokerError {
    BrokerError::Invalid(format!("delegation storage: {e}"))
}

/// `grants.organization_id` carries a foreign key. Organization membership is
/// established by Identity before the Host mints a session; materialize the
/// trusted tenant locally so a grant can satisfy the boundary (the same rule
/// `Db::insert_connection` follows).
pub(super) async fn materialize_organization<'e, E>(
    executor: E,
    organization_id: &str,
) -> Result<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
        .bind(organization_id)
        .bind(organization_id)
        .bind(now_rfc3339())
        .execute(executor)
        .await
        .map_err(internal)?;
    Ok(())
}
