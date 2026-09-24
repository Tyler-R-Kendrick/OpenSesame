//! Access domains: the realm-bound administrative forest.
//!
//! A domain is a policy context, not a vault and not a tenant. Its realm is part
//! of its identity (`UNIQUE (id, organization_id)`), and its parent is
//! referenced by that pair, so a cross-realm parent is not a case to authorize —
//! it cannot be written. Every mutation is a compare-and-set on `revision`, and
//! every mutation that changes what a descendant inherits advances the
//! invalidation generation of the whole subtree, so authority issued under the
//! old shape stops passing its fence at the moment of commit rather than after a
//! background walk.

use super::{bump_generation_tx, generation_tx, DOMAIN, REALM};
use crate::{append_outbox_tx, Db, Row, Utc};

/// A domain to create. `parent_id` is `None` for a realm-root domain.
pub struct NewAccessDomain<'a> {
    pub id: &'a str,
    pub organization_id: &'a str,
    pub parent_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
}

/// A reparent request. `expected_revision` is the precondition: a caller that
/// read the domain, showed an impact preview and then lost a race writes
/// nothing.
pub struct DomainReparent<'a> {
    pub organization_id: &'a str,
    pub id: &'a str,
    pub expected_revision: i64,
    pub new_parent_id: Option<&'a str>,
}

/// A stored domain.
pub struct AccessDomain {
    pub id: String,
    pub organization_id: String,
    pub parent_id: Option<String>,
    pub project_id: Option<String>,
    pub lifecycle: String,
    pub revision: i64,
    pub depth: i64,
}

/// The forest's depth ceiling. Ancestry is walked in bounded loops and recorded
/// in `grant_ancestors` with a `distance` check, so the bound is part of the
/// schema rather than a convention.
const MAX_DEPTH: i64 = 32;

impl Db {
    /// Create a domain inside one realm.
    ///
    /// Returns `false` when the named parent is absent, terminated, in another
    /// realm, or already at the depth ceiling — a refusal, not an error.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert or its outbox event cannot commit.
    pub async fn create_access_domain(&self, new: &NewAccessDomain<'_>) -> anyhow::Result<bool> {
        let stamp = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let depth = match new.parent_id {
            None => 0,
            Some(parent) => {
                let row = sqlx::query(
                    "SELECT depth FROM access_domains \
                     WHERE id = ? AND organization_id = ? AND lifecycle = 'active'",
                )
                .bind(parent)
                .bind(new.organization_id)
                .fetch_optional(&mut *tx)
                .await?;
                let Some(row) = row else { return Ok(false) };
                row.get::<i64, _>("depth") + 1
            }
        };
        if depth > MAX_DEPTH {
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO access_domains \
             (id, organization_id, parent_id, project_id, lifecycle, revision, depth, \
              created_at, updated_at) \
             VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)",
        )
        .bind(new.id)
        .bind(new.organization_id)
        .bind(new.parent_id)
        .bind(new.project_id)
        .bind(depth)
        .bind(&stamp)
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
        generation_tx(
            &mut tx,
            new.organization_id,
            REALM,
            new.organization_id,
            &stamp,
        )
        .await?;
        generation_tx(&mut tx, new.organization_id, DOMAIN, new.id, &stamp).await?;
        append_outbox_tx(
            &mut tx,
            "authority.domain.created",
            &serde_json::json!({
                "organization_id": new.organization_id,
                "domain_id": new.id,
                "parent_id": new.parent_id,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Read one domain, realm-scoped.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored row cannot be decoded.
    pub async fn access_domain(
        &self,
        organization_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<AccessDomain>> {
        let row = sqlx::query(
            "SELECT id, organization_id, parent_id, project_id, lifecycle, revision, depth \
             FROM access_domains WHERE id = ? AND organization_id = ?",
        )
        .bind(id)
        .bind(organization_id)
        .fetch_optional(self.pool())
        .await?;
        row.map(|row| {
            Ok(AccessDomain {
                id: row.try_get("id")?,
                organization_id: row.try_get("organization_id")?,
                parent_id: row.try_get("parent_id")?,
                project_id: row.try_get("project_id")?,
                lifecycle: row.try_get("lifecycle")?,
                revision: row.try_get("revision")?,
                depth: row.try_get("depth")?,
            })
        })
        .transpose()
    }

    /// List domains in one realm, ordered by depth then id.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored row cannot be decoded.
    pub async fn list_access_domains(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<AccessDomain>> {
        let rows = sqlx::query(
            "SELECT id, organization_id, parent_id, project_id, lifecycle, revision, depth \
             FROM access_domains WHERE organization_id = ? \
             ORDER BY depth ASC, id ASC",
        )
        .bind(organization_id)
        .fetch_all(self.pool())
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(AccessDomain {
                    id: row.try_get("id")?,
                    organization_id: row.try_get("organization_id")?,
                    parent_id: row.try_get("parent_id")?,
                    project_id: row.try_get("project_id")?,
                    lifecycle: row.try_get("lifecycle")?,
                    revision: row.try_get("revision")?,
                    depth: row.try_get("depth")?,
                })
            })
            .collect()
    }

    /// Move a domain within its realm under a revision precondition.
    ///
    /// Refuses (`false`) a stale revision, a parent in another realm, a parent
    /// that is not active, a move that would exceed the depth ceiling, and a
    /// move into the domain's own subtree. The subtree's depths are corrected
    /// and its invalidation generations advanced in the same transaction, so no
    /// descendant is briefly authorized under two different sets of inherited
    /// guardrails.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn reparent_access_domain(
        &self,
        request: &DomainReparent<'_>,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        // Every read here is inside the write transaction. Reading through the pool
        // instead would need a second connection this store does not have, and
        // would read a state the transaction may already have changed.
        let Some((lifecycle, revision, depth)) =
            domain_state_tx(&mut tx, request.organization_id, request.id).await?
        else {
            return Ok(false);
        };
        if revision != request.expected_revision || lifecycle != "active" {
            return Ok(false);
        }
        let subtree = subtree_ids_tx(&mut tx, request.organization_id, request.id).await?;
        let parent_depth = match request.new_parent_id {
            None => -1,
            Some(parent) => {
                if parent == request.id || subtree.iter().any(|id| id == parent) {
                    return Ok(false);
                }
                match domain_state_tx(&mut tx, request.organization_id, parent).await? {
                    Some((parent_lifecycle, _, parent_depth)) if parent_lifecycle == "active" => {
                        parent_depth
                    }
                    _ => return Ok(false),
                }
            }
        };
        let delta = parent_depth + 1 - depth;
        let deepest = subtree_max_depth_tx(&mut tx, request.organization_id, &subtree).await?;
        if deepest + delta > MAX_DEPTH {
            return Ok(false);
        }
        let changed = sqlx::query(
            "UPDATE access_domains \
             SET parent_id = ?, depth = depth + ?, revision = revision + 1, updated_at = ? \
             WHERE id = ? AND organization_id = ? AND revision = ? AND lifecycle = 'active'",
        )
        .bind(request.new_parent_id)
        .bind(delta)
        .bind(&now)
        .bind(request.id)
        .bind(request.organization_id)
        .bind(request.expected_revision)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed != 1 {
            return Ok(false);
        }
        for descendant in subtree {
            if descendant != request.id {
                sqlx::query(
                    "UPDATE access_domains SET depth = depth + ?, updated_at = ? \
                     WHERE id = ? AND organization_id = ?",
                )
                .bind(delta)
                .bind(&now)
                .bind(&descendant)
                .bind(request.organization_id)
                .execute(&mut *tx)
                .await?;
            }
            bump_generation_tx(&mut tx, request.organization_id, DOMAIN, &descendant, &now).await?;
        }
        append_outbox_tx(
            &mut tx,
            "authority.domain.reparented",
            &serde_json::json!({
                "organization_id": request.organization_id,
                "domain_id": request.id,
                "parent_id": request.new_parent_id,
            })
            .to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Terminate a domain and fence its subtree.
    ///
    /// Terminating does not delete a grant or its evidence: the domain stops
    /// being `active`, every descendant domain's generation advances, and the
    /// fenced read refuses authority in that subtree from the commit onward.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed.
    pub async fn terminate_access_domain(
        &self,
        organization_id: &str,
        id: &str,
        expected_revision: i64,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let subtree = subtree_ids_tx(&mut tx, organization_id, id).await?;
        let changed = sqlx::query(
            "UPDATE access_domains \
             SET lifecycle = 'terminated', terminated_at = ?, revision = revision + 1, \
                 updated_at = ? \
             WHERE id = ? AND organization_id = ? AND revision = ? AND lifecycle <> 'terminated'",
        )
        .bind(&now)
        .bind(&now)
        .bind(id)
        .bind(organization_id)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed != 1 {
            return Ok(false);
        }
        for descendant in subtree {
            bump_generation_tx(&mut tx, organization_id, DOMAIN, &descendant, &now).await?;
        }
        append_outbox_tx(
            &mut tx,
            "authority.domain.terminated",
            &serde_json::json!({"organization_id": organization_id, "domain_id": id}).to_string(),
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }
}

/// Collect a subtree's domain ids, realm-scoped and depth-bounded.
async fn subtree_ids_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    organization_id: &str,
    root: &str,
) -> anyhow::Result<Vec<String>> {
    let rows = sqlx::query(
        "WITH RECURSIVE sub(id, hops) AS ( \
           SELECT id, 0 FROM access_domains WHERE id = ? AND organization_id = ? \
           UNION ALL \
           SELECT d.id, sub.hops + 1 FROM access_domains d JOIN sub ON d.parent_id = sub.id \
             WHERE d.organization_id = ? AND sub.hops < ? \
         ) SELECT id FROM sub",
    )
    .bind(root)
    .bind(organization_id)
    .bind(organization_id)
    .bind(MAX_DEPTH)
    .fetch_all(&mut **tx)
    .await?;
    rows.into_iter().map(|row| Ok(row.try_get("id")?)).collect()
}

/// One domain's lifecycle, revision and depth.
async fn domain_state_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    organization_id: &str,
    id: &str,
) -> anyhow::Result<Option<(String, i64, i64)>> {
    let row = sqlx::query(
        "SELECT lifecycle, revision, depth FROM access_domains \
         WHERE id = ? AND organization_id = ?",
    )
    .bind(id)
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| {
        Ok((
            row.try_get("lifecycle")?,
            row.try_get("revision")?,
            row.try_get("depth")?,
        ))
    })
    .transpose()
}

async fn subtree_max_depth_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    organization_id: &str,
    subtree: &[String],
) -> anyhow::Result<i64> {
    let mut deepest = 0;
    for id in subtree {
        if let Some((_, _, depth)) = domain_state_tx(tx, organization_id, id).await? {
            deepest = deepest.max(depth);
        }
    }
    Ok(deepest)
}
