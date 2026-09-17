//! Persistence for generalized, hierarchical authority.
//!
//! The tables are described in `migrations/0033_general_authority.sql`; this
//! module is the only writer of them. Four rules hold across every submodule:
//!
//! * a realm (`organization_id`) is part of every key and every predicate, so a
//!   lookup that forgets it cannot compile a row from another tenant;
//! * a security mutation is a transaction that also writes its outbox event, so
//!   an effect never exists without the record of it;
//! * a deny is a zero-row write or a `None` read, never an in-memory decision a
//!   caller may skip;
//! * an authority object records the generations it was issued against, and a
//!   revoke, a reparent or a recovery rotation moves a generation. Nothing is
//!   swept: the pin stops matching, and the fenced read stops answering.
//!
//! `grant_authority` extends the existing `grants` row rather than replacing it.
//! A grant with no sidecar is a legacy grant, and it cannot satisfy a
//! generalized dispatch — which is why `migrate` exists and why it refuses what
//! it cannot faithfully translate.

mod budget;
mod domains;
mod effects;
mod expiry;
mod grants;
mod invoke_spend;
mod legacy_record;
mod migrate;
mod offers;
mod projection;
mod restore;

#[cfg(test)]
mod fix_contractor;
#[cfg(test)]
mod fix_family;
#[cfg(test)]
mod fix_raid;
#[cfg(test)]
mod fix_support;
#[cfg(test)]
mod fix_workcell;
#[cfg(test)]
mod offers_live;
#[cfg(test)]
mod outbox_tests;
#[cfg(test)]
mod tests;

pub use budget::{BudgetScope, Reservation, ReserveOutcome, SettleOutcome};
pub use domains::{AccessDomain, DomainReparent, NewAccessDomain};
pub use effects::{DesiredEffect, EffectObservation};
pub use expiry::AuthorityGrantDeadline;
pub use grants::{AuthorityIssue, FencedAuthority, PermissionEntry};
pub use invoke_spend::InvokeBudgetOutcome;
pub use migrate::{BackfillPlan, BackfillReport};
pub use offers::{ActivationOutcome, NewGrantOffer, OfferActivation};
pub use projection::{ProjectionMark, WriterLease};
pub use restore::{GenerationWitness, OperationalGeneration};

use sqlx::{Row, Sqlite, Transaction};

/// Authority subjects that carry an invalidation generation. The strings are
/// the `authority_generations.subject_kind` enumeration, checked by the schema:
/// a typo would otherwise record a fence against nothing and quietly stop
/// fencing the subject it was meant to protect.
pub(crate) const REALM: &str = "realm";
pub(crate) const DOMAIN: &str = "domain";
pub(crate) const GRANT: &str = "grant";

/// Read a subject's current invalidation generation, seeding it at 1.
///
/// Seeding on read keeps "never revoked" and "revoked zero times" the same
/// state, so a first authorization does not have to be preceded by an
/// administrative write to be fenceable.
///
/// # Errors
///
/// Returns an error when the row cannot be read or seeded.
pub(crate) async fn generation_tx(
    tx: &mut Transaction<'_, Sqlite>,
    organization_id: &str,
    subject_kind: &str,
    subject_id: &str,
    now: &str,
) -> anyhow::Result<i64> {
    sqlx::query(
        "INSERT INTO authority_generations \
         (organization_id, subject_kind, subject_id, generation, updated_at) \
         VALUES (?, ?, ?, 1, ?) \
         ON CONFLICT (organization_id, subject_kind, subject_id) DO NOTHING",
    )
    .bind(organization_id)
    .bind(subject_kind)
    .bind(subject_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    let row = sqlx::query(
        "SELECT generation FROM authority_generations \
         WHERE organization_id = ? AND subject_kind = ? AND subject_id = ?",
    )
    .bind(organization_id)
    .bind(subject_kind)
    .bind(subject_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(row.get::<i64, _>("generation"))
}

/// Advance a subject's invalidation generation. This is the whole revocation
/// fence: every descendant that pinned the old value stops passing its fenced
/// read when this commits, with no tree walk in between.
///
/// # Errors
///
/// Returns an error when the generation cannot be seeded or advanced.
pub(crate) async fn bump_generation_tx(
    tx: &mut Transaction<'_, Sqlite>,
    organization_id: &str,
    subject_kind: &str,
    subject_id: &str,
    now: &str,
) -> anyhow::Result<i64> {
    generation_tx(tx, organization_id, subject_kind, subject_id, now).await?;
    sqlx::query(
        "UPDATE authority_generations SET generation = generation + 1, updated_at = ? \
         WHERE organization_id = ? AND subject_kind = ? AND subject_id = ?",
    )
    .bind(now)
    .bind(organization_id)
    .bind(subject_kind)
    .bind(subject_id)
    .execute(&mut **tx)
    .await?;
    generation_tx(tx, organization_id, subject_kind, subject_id, now).await
}

/// The operational generation the database is currently running under, read
/// inside a caller's transaction so a write and its pin cannot straddle a
/// recovery rotation.
///
/// # Errors
///
/// Returns an error when the singleton row is missing or unreadable.
pub(crate) async fn operational_generation_tx(
    tx: &mut Transaction<'_, Sqlite>,
) -> anyhow::Result<i64> {
    let row = sqlx::query("SELECT generation FROM authority_operational_generation WHERE id = 1")
        .fetch_one(&mut **tx)
        .await?;
    Ok(row.get::<i64, _>("generation"))
}
