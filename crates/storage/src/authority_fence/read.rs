//! The read side of the fence: one query for a whole chain, and the
//! three-valued answer it produces.
//!
//! Split from `mod.rs` to stay inside the 400-line module budget (ADR 0093).

use opensesame_lifecycle::{
    evaluate_fence, missing_lineage, store_unavailable, FenceReading, FenceVerdict, Freshness,
    Invalidation, Lineage, Uncertainty,
};
use sqlx::{Row as _, SqlitePool};

/// The highest invalidation sequence recorded — the fence's high-water mark.
///
/// # Errors
///
/// Returns an error when the query fails.
pub async fn fence_high_water(pool: &SqlitePool) -> anyhow::Result<u64> {
    let mark: i64 =
        sqlx::query("SELECT COALESCE(MAX(sequence), 0) AS mark FROM grant_invalidations")
            .fetch_one(pool)
            .await?
            .get("mark");
    Ok(mark.try_into().unwrap_or(0))
}

/// Read the fence for one grant's whole chain in a single query.
///
/// This is the property that replaces the walk: the lineage is already
/// materialized, so one indexed lookup answers for every ancestor at once
/// instead of one round trip per hop.
///
/// # Errors
///
/// Returns an error only when the query itself fails; a missing lineage or a
/// malformed one is reported as a denying verdict, not an error, so callers
/// cannot accidentally treat it as a transient failure and retry into an
/// allow.
async fn read_fence(pool: &SqlitePool, grant_id: &str) -> anyhow::Result<FenceResult> {
    let row = sqlx::query(
        "SELECT ancestor_path, root_grant_id, depth FROM grant_lineage WHERE grant_id = ?",
    )
    .bind(grant_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(FenceResult::Verdict(missing_lineage(grant_id)));
    };
    let path: String = row.get("ancestor_path");
    let lineage = match Lineage::from_path(&path) {
        Ok(lineage) => lineage,
        Err(error) => {
            return Ok(FenceResult::Verdict(FenceVerdict::Indeterminate {
                cause: Uncertainty::LineageUnusable {
                    grant_id: grant_id.to_string(),
                    detail: error.to_string(),
                },
            }))
        }
    };

    // The row's own columns must agree with the path it stores. A disagreement
    // means one of them is stale, and neither can then be trusted to say which
    // ancestors to check.
    let stored_root: String = row.get("root_grant_id");
    let stored_depth: i64 = row.get("depth");
    if stored_root != lineage.root_id() || stored_depth != i64::from(lineage.depth()) {
        return Ok(FenceResult::Verdict(FenceVerdict::Indeterminate {
            cause: Uncertainty::LineageInconsistent {
                grant_id: grant_id.to_string(),
                detail: format!(
                    "row says root {stored_root} depth {stored_depth}; path says root {} depth {}",
                    lineage.root_id(),
                    lineage.depth()
                ),
            },
        }));
    }
    if lineage.grant_id() != grant_id {
        return Ok(FenceResult::Verdict(FenceVerdict::Indeterminate {
            cause: Uncertainty::LineageInconsistent {
                grant_id: grant_id.to_string(),
                detail: format!("path ends at {}", lineage.grant_id()),
            },
        }));
    }

    // One query for the whole chain. The high-water mark is read in the same
    // statement so the reported freshness cannot be newer than the rows.
    let mut builder = sqlx::QueryBuilder::new(
        "SELECT grant_id, sequence, reason,
                (SELECT COALESCE(MAX(sequence), 0) FROM grant_invalidations) AS mark
           FROM grant_invalidations WHERE grant_id IN (",
    );
    let mut separated = builder.separated(", ");
    for id in lineage.chain() {
        separated.push_bind(id.clone());
    }
    builder.push(")");
    let rows = builder.build().fetch_all(pool).await?;

    let observed_sequence = match rows.first() {
        Some(row) => {
            let mark: i64 = row.get("mark");
            mark.try_into().unwrap_or(0)
        }
        // No invalidation touches this chain, so the chain's rows tell us
        // nothing about the mark; read it on its own.
        None => fence_high_water(pool).await?,
    };
    let invalidations = rows
        .iter()
        .map(|row| {
            let sequence: i64 = row.get("sequence");
            Invalidation {
                grant_id: row.get("grant_id"),
                sequence: sequence.try_into().unwrap_or(0),
                reason: row.get("reason"),
            }
        })
        .collect();

    Ok(FenceResult::Reading {
        lineage,
        reading: FenceReading {
            observed_sequence,
            invalidations,
        },
    })
}

/// Either a reading to evaluate, or a verdict already settled by the read.
enum FenceResult {
    Reading {
        lineage: Lineage,
        reading: FenceReading,
    },
    Verdict(FenceVerdict),
}

/// The fence verdict for one grant. Deny unless this returns
/// [`FenceVerdict::Clear`].
///
/// Never returns an error: a query failure becomes
/// [`Uncertainty::StoreUnavailable`], which denies. A caller that could
/// receive `Err` would have somewhere to put a `?` and accidentally turn a
/// database hiccup into a retry that allows.
pub async fn fence_status(pool: &SqlitePool, grant_id: &str, freshness: Freshness) -> FenceVerdict {
    match read_fence(pool, grant_id).await {
        Ok(FenceResult::Verdict(verdict)) => verdict,
        Ok(FenceResult::Reading { lineage, reading }) => {
            evaluate_fence(&lineage, &reading, freshness)
        }
        Err(error) => {
            tracing::warn!(%error, grant_id, "fence read failed; denying");
            store_unavailable(&error.to_string())
        }
    }
}
