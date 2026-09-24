//! The rows an issuance writes: the `grant_authority` sidecar and its
//! correlated `grant_permission_entries`, inside the issuing transaction.

use super::{AuthorityIssue, PermissionEntry};

pub(super) async fn insert_sidecar(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    issue: &AuthorityIssue<'_>,
    root: &str,
    generations: [i64; 3],
    now: &str,
) -> anyhow::Result<()> {
    let [realm, domain, operational] = generations;
    sqlx::query(
        "INSERT INTO grant_authority \
         (grant_id, organization_id, domain_id, root_grant_id, parent_grant_id, revision, \
          issuance_basis, lineage_digest, policy_digest, role_revision, offer_id, \
          delegation_depth_remaining, not_before, expires_at, realm_generation, \
          domain_generation, operational_generation, evidence_id, created_at) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(issue.grant_id)
    .bind(issue.organization_id)
    .bind(issue.domain_id)
    .bind(root)
    .bind(issue.parent_grant_id)
    .bind(issue.issuance_basis)
    .bind(issue.lineage_digest)
    .bind(issue.policy_digest)
    .bind(issue.role_revision)
    .bind(issue.offer_id)
    .bind(issue.delegation_depth_remaining)
    .bind(issue.not_before.to_rfc3339())
    .bind(issue.expires_at.to_rfc3339())
    .bind(realm)
    .bind(domain)
    .bind(operational)
    .bind(issue.evidence_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) async fn insert_entries(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    issue: &AuthorityIssue<'_>,
    entries: &[PermissionEntry],
) -> anyhow::Result<()> {
    for (index, entry) in entries.iter().enumerate() {
        let seq = i64::try_from(index)?;
        sqlx::query(
            "INSERT INTO grant_permission_entries \
             (grant_id, organization_id, seq, resource_selector, provider_operation_id, \
              action_set_json, parameter_constraints_json, audience_set_json, manifest_digest) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(issue.grant_id)
        .bind(issue.organization_id)
        .bind(seq)
        .bind(&entry.resource_selector)
        .bind(&entry.provider_operation_id)
        .bind(&entry.action_set_json)
        .bind(&entry.parameter_constraints_json)
        .bind(&entry.audience_set_json)
        .bind(&entry.manifest_digest)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}
