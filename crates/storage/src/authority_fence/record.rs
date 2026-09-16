//! Recording a grant's lineage, in the transaction that writes the grant.
//!
//! Split from `mod.rs` to stay inside the 400-line module budget (ADR 0093).

use opensesame_lifecycle::Lineage;
use sqlx::{Row as _, Sqlite, Transaction};

use crate::now_rfc3339;

/// How the fence describes a grant it has just blocked, for logs and receipts.
pub const REASON_OWNER_REVOKED: &str = "owner-revoked";

/// Record one grant's lineage, in the transaction that writes the grant.
///
/// A root passes `parent_grant_id: None`. A child's parent must already have
/// a lineage row: without it the child's ancestry is unknown, and recording a
/// guess (treating it as a root, say) would mint a grant the fence could
/// never reach from above. That is refused here rather than discovered later.
///
/// Idempotent, so a load-or-create root grant may call it on every load.
///
/// # Errors
///
/// Returns an error when the parent has no lineage row, the chain would
/// exceed [`MAX_FENCE_DEPTH`], an id cannot appear in a path, or the insert
/// fails.
pub async fn record_lineage(
    tx: &mut Transaction<'_, Sqlite>,
    grant_id: &str,
    parent_grant_id: Option<&str>,
) -> anyhow::Result<Lineage> {
    let lineage = match parent_grant_id {
        None => Lineage::root(grant_id)?,
        Some(parent_id) => {
            let parent_path: Option<String> =
                sqlx::query("SELECT ancestor_path FROM grant_lineage WHERE grant_id = ?")
                    .bind(parent_id)
                    .fetch_optional(&mut **tx)
                    .await?
                    .map(|row| row.get("ancestor_path"));
            let Some(parent_path) = parent_path else {
                anyhow::bail!(
                    "parent grant {parent_id} has no recorded lineage; \
                     refusing to record {grant_id} with an unprovable ancestry"
                );
            };
            Lineage::child_of(&Lineage::from_path(&parent_path)?, grant_id)?
        }
    };
    sqlx::query(
        "INSERT OR IGNORE INTO grant_lineage
         (grant_id, root_grant_id, parent_grant_id, depth, ancestor_path, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(lineage.grant_id())
    .bind(lineage.root_id())
    .bind(lineage.parent_id())
    .bind(i64::from(lineage.depth()))
    .bind(lineage.path())
    .bind(now_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(lineage)
}
