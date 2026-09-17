//! The grant sidecar: generalized authority on top of the existing `grants` row.
//!
//! There is no second grant store. `insert_grant` still writes the envelope;
//! `issue_authority` records what the generalized model adds — the domain, the
//! lineage, the reviewed digests, the correlated permission entries, and the
//! generations the issuance was pinned to.
//!
//! `fenced_authority` is the deny boundary, and it is deliberately not a second
//! opinion about ancestry. Chain invalidation belongs to `grant_lineage` /
//! `grant_invalidations` ([ADR 0120](../../../docs/adr/0120), `authority_fence`),
//! so this asks that fence for the chain and adds only what it cannot know:
//! whether the grant's realm is fenced, whether its domain is still active and at
//! the generation the issuance pinned, whether the clock is inside
//! `[not_before, expires_at)`, and whether the database is still serving the
//! operational generation the authority was issued under. Only `FenceVerdict::Clear`
//! passes — a chain whose lineage is unknown is `Indeterminate`, which denies.
//!
//! An ancestor's expiry needs no clause of its own: a child's window is contained
//! in its parent's, so a parent that has expired has taken its descendants with it.

use super::{bump_generation_tx, generation_tx, operational_generation_tx, DOMAIN, GRANT, REALM};
use crate::authority_fence::record_lineage;
use crate::{append_outbox_tx, Db, Row, Utc};
use chrono::{DateTime, Utc as ChronoUtc};
use opensesame_lifecycle::{FenceVerdict, Freshness};

/// One correlated right. The correlation is the point: an entry pairs its action
/// set with the one resource selector, provider operation, parameter constraints
/// and audience it was reviewed against, so two entries can never be recombined
/// into a right neither of them granted.
#[derive(Clone)]
pub struct PermissionEntry {
    pub resource_selector: String,
    pub provider_operation_id: String,
    pub action_set_json: String,
    pub parameter_constraints_json: String,
    pub audience_set_json: String,
    pub manifest_digest: String,
}

/// An issuance to record against an existing `grants` row.
pub struct AuthorityIssue<'a> {
    pub grant_id: &'a str,
    pub organization_id: &'a str,
    pub domain_id: &'a str,
    pub parent_grant_id: Option<&'a str>,
    pub issuance_basis: &'a str,
    pub lineage_digest: &'a str,
    pub policy_digest: &'a str,
    pub role_revision: Option<i64>,
    pub offer_id: Option<&'a str>,
    pub delegation_depth_remaining: i64,
    pub not_before: DateTime<ChronoUtc>,
    pub expires_at: DateTime<ChronoUtc>,
    pub evidence_id: Option<&'a str>,
}

/// Authority that passed the fence, with the entries that were reviewed with it.
pub struct FencedAuthority {
    pub grant_id: String,
    pub organization_id: String,
    pub domain_id: String,
    pub root_grant_id: String,
    pub revision: i64,
    pub delegation_depth_remaining: i64,
    pub policy_digest: String,
    pub lineage_digest: String,
    pub entries: Vec<PermissionEntry>,
}

impl Db {
    /// Record generalized authority for a grant that already exists.
    ///
    /// Refuses (`false`) when the grant is absent or revoked, when the domain is
    /// not active in the same realm, when the parent sidecar is absent or does
    /// not currently pass its own fence, when the child's window is not inside
    /// the parent's, when the delegation budget does not strictly decrease, and
    /// when the chain would exceed the depth ceiling. These are structural
    /// storage invariants; the full attenuation contract is the grant engine's.
    ///
    /// # Errors
    ///
    /// Returns an error when no permission entry is supplied — authority with no
    /// correlated right would read as authority while allowing nothing — or when
    /// the transaction cannot commit.
    pub async fn issue_authority(
        &self,
        issue: &AuthorityIssue<'_>,
        entries: &[PermissionEntry],
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            !entries.is_empty(),
            "generalized authority requires at least one permission entry"
        );
        anyhow::ensure!(
            issue.expires_at > issue.not_before,
            "authority interval must be non-empty"
        );
        let Some(root) = self.issuance_root(issue).await? else {
            return Ok(false);
        };
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let realm = generation_tx(
            &mut tx,
            issue.organization_id,
            REALM,
            issue.organization_id,
            &now,
        )
        .await?;
        let domain = generation_tx(
            &mut tx,
            issue.organization_id,
            DOMAIN,
            issue.domain_id,
            &now,
        )
        .await?;
        let operational = operational_generation_tx(&mut tx).await?;
        insert_sidecar(&mut tx, issue, &root, [realm, domain, operational], &now).await?;
        insert_entries(&mut tx, issue, entries).await?;
        // The chain's own record, in the transaction that writes the authority: a
        // grant that exists without a lineage row denies until one appears, so it
        // must not be written by a later pass.
        record_lineage(&mut tx, issue.grant_id, issue.parent_grant_id).await?;
        generation_tx(&mut tx, issue.organization_id, GRANT, issue.grant_id, &now).await?;
        append_outbox_tx(
            &mut tx,
            "authority.grant.issued",
            &serde_json::json!({
                "organization_id": issue.organization_id,
                "grant_id": issue.grant_id,
                "domain_id": issue.domain_id,
                "root_grant_id": root,
                "issuance_basis": issue.issuance_basis,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn authority_sidecar_present(
        &self,
        organization_id: &str,
        grant_id: &str,
    ) -> anyhow::Result<bool> {
        self.exists(SIDECAR_PRESENT_SQL, grant_id, organization_id)
            .await
    }
    /// Read authority only if it currently passes every fence.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored row cannot be decoded.
    pub async fn fenced_authority(
        &self,
        organization_id: &str,
        grant_id: &str,
        now: DateTime<ChronoUtc>,
    ) -> anyhow::Result<Option<FencedAuthority>> {
        let instant = now.to_rfc3339();
        let row = sqlx::query(FENCED_AUTHORITY_SQL)
            .bind(grant_id)
            .bind(organization_id)
            .bind(&instant)
            .bind(&instant)
            .fetch_optional(self.pool())
            .await?;
        let Some(row) = row else { return Ok(None) };
        if !matches!(
            self.fence_status(grant_id, Freshness::any()).await,
            FenceVerdict::Clear { .. }
        ) {
            return Ok(None);
        }
        Ok(Some(FencedAuthority {
            grant_id: row.try_get("grant_id")?,
            organization_id: row.try_get("organization_id")?,
            domain_id: row.try_get("domain_id")?,
            root_grant_id: row.try_get("root_grant_id")?,
            revision: row.try_get("revision")?,
            delegation_depth_remaining: row.try_get("delegation_depth_remaining")?,
            policy_digest: row.try_get("policy_digest")?,
            lineage_digest: row.try_get("lineage_digest")?,
            entries: self.permission_entries(organization_id, grant_id).await?,
        }))
    }

    /// Read the correlated entries recorded with one authority.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored row cannot be decoded.
    pub async fn permission_entries(
        &self,
        organization_id: &str,
        grant_id: &str,
    ) -> anyhow::Result<Vec<PermissionEntry>> {
        let rows = sqlx::query(
            "SELECT resource_selector, provider_operation_id, action_set_json, \
                    parameter_constraints_json, audience_set_json, manifest_digest \
             FROM grant_permission_entries \
             WHERE grant_id = ? AND organization_id = ? ORDER BY seq",
        )
        .bind(grant_id)
        .bind(organization_id)
        .fetch_all(self.pool())
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(PermissionEntry {
                    resource_selector: row.try_get("resource_selector")?,
                    provider_operation_id: row.try_get("provider_operation_id")?,
                    action_set_json: row.try_get("action_set_json")?,
                    parameter_constraints_json: row.try_get("parameter_constraints_json")?,
                    audience_set_json: row.try_get("audience_set_json")?,
                    manifest_digest: row.try_get("manifest_digest")?,
                })
            })
            .collect()
    }

    // Revoking one grant is `Db::fence_grant`, not a method here. A revoke must
    // stop every descendant at one commit, and that is exactly what the 0120
    // fence does. A second revocation path beside it would be a second
    // linearization point for the same event, which is how a grant comes to be
    // revoked by one mechanism and live by the other.

    /// Fence every grant in one realm, for the case where the realm itself is
    /// suspended. Returns the realm's new generation.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn revoke_realm_authority(&self, organization_id: &str) -> anyhow::Result<i64> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let generation =
            bump_generation_tx(&mut tx, organization_id, REALM, organization_id, &now).await?;
        append_outbox_tx(
            &mut tx,
            "authority.realm.fenced",
            &serde_json::json!({
                "organization_id": organization_id,
                "realm_generation": generation,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(generation)
    }

    /// Resolve the root this issuance would belong to, refusing every structural
    /// precondition failure with `None`.
    async fn issuance_root(&self, issue: &AuthorityIssue<'_>) -> anyhow::Result<Option<String>> {
        if !self
            .exists(GRANT_LIVE_SQL, issue.grant_id, issue.organization_id)
            .await?
            || !self
                .exists(DOMAIN_ACTIVE_SQL, issue.domain_id, issue.organization_id)
                .await?
        {
            return Ok(None);
        }
        let Some(parent_id) = issue.parent_grant_id else {
            return Ok(Some(issue.grant_id.to_owned()));
        };
        let Some(parent) = self
            .fenced_authority(issue.organization_id, parent_id, ChronoUtc::now())
            .await?
        else {
            return Ok(None);
        };
        if parent.delegation_depth_remaining <= issue.delegation_depth_remaining {
            return Ok(None);
        }
        let within = sqlx::query(
            "SELECT 1 AS within FROM grant_authority \
             WHERE grant_id = ? AND organization_id = ? AND not_before <= ? AND expires_at >= ?",
        )
        .bind(parent_id)
        .bind(issue.organization_id)
        .bind(issue.not_before.to_rfc3339())
        .bind(issue.expires_at.to_rfc3339())
        .fetch_optional(self.pool())
        .await?;
        if within.is_none() {
            return Ok(None);
        }
        Ok(Some(parent.root_grant_id))
    }

    async fn exists(&self, sql: &str, id: &str, organization_id: &str) -> anyhow::Result<bool> {
        let row = sqlx::query(sql)
            .bind(id)
            .bind(organization_id)
            .fetch_optional(self.pool())
            .await?;
        Ok(row.is_some())
    }
}

async fn insert_sidecar(
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

async fn insert_entries(
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

const SIDECAR_PRESENT_SQL: &str =
    "SELECT 1 AS live FROM grant_authority WHERE grant_id = ? AND organization_id = ?";

const GRANT_LIVE_SQL: &str = "SELECT 1 AS live FROM grants \
     WHERE id = ? AND organization_id = ? AND revoked_at IS NULL";

const DOMAIN_ACTIVE_SQL: &str = "SELECT 1 AS active FROM access_domains \
     WHERE id = ? AND organization_id = ? AND lifecycle = 'active'";

const FENCED_AUTHORITY_SQL: &str = "\
SELECT a.grant_id, a.organization_id, a.domain_id, a.root_grant_id, a.revision, \
       a.delegation_depth_remaining, a.policy_digest, a.lineage_digest \
FROM grant_authority a \
JOIN grants g ON g.id = a.grant_id AND g.organization_id = a.organization_id \
JOIN access_domains d ON d.id = a.domain_id AND d.organization_id = a.organization_id \
JOIN authority_operational_generation o ON o.id = 1 \
LEFT JOIN authority_generations rg ON rg.organization_id = a.organization_id \
     AND rg.subject_kind = 'realm' AND rg.subject_id = a.organization_id \
LEFT JOIN authority_generations dg ON dg.organization_id = a.organization_id \
     AND dg.subject_kind = 'domain' AND dg.subject_id = a.domain_id \
WHERE a.grant_id = ? AND a.organization_id = ? \
  AND g.revoked_at IS NULL \
  AND d.lifecycle = 'active' \
  AND a.not_before <= ? AND a.expires_at > ? \
  AND a.operational_generation = o.generation \
  AND a.realm_generation = COALESCE(rg.generation, 1) \
  AND a.domain_generation = COALESCE(dg.generation, 1)";
