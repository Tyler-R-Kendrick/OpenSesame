//! The organization policies the store decides itself (ADR 0148 §9): two-step
//! login and single organization, which guard who may be a member at all.
//!
//! Each decision is made in the same write transaction as the change it
//! guards, and the transaction takes the write lock before it reads anything.
//! A member cannot be confirmed, demoted, restored or imported while a
//! policy that excludes them is being enabled, nor an organization created
//! while a single-organization policy binds its creator: whichever commits
//! first, the other sees it. A policy being enabled revokes the members it
//! excludes in the same transaction that enables it, so it is never on with
//! a violator still confirmed.
//!
//! Owners and administrators are exempt from the policies of the organization
//! they run — but not from a policy that binds them in another organization.

use chrono::Utc;
use sqlx::{Row as _, SqliteConnection, SqlitePool};

use super::accounts::bitwarden_timestamp;
use super::collections::insert_collection;
use super::orgs::{insert_member, insert_org};
use super::{
    member_status, member_type, BitwardenCollection, BitwardenOrgMember, BitwardenOrganization,
    BitwardenPolicy,
};
use crate::Db;

/// Policy types the store enforces, as Bitwarden numbers them.
pub mod policy_type {
    pub const TWO_STEP_LOGIN: i64 = 0;
    pub const SINGLE_ORGANIZATION: i64 = 3;
}

/// Why a member may not stand in an organization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyViolation {
    /// The organization requires two-step login, which the account lacks.
    TwoStepLogin,
    /// A single-organization policy keeps the account to one organization.
    SingleOrganization,
}

/// Start a transaction holding the write lock, as the authority fence does:
/// a statement that writes nothing still takes it.
pub(super) async fn begin_write(
    pool: &SqlitePool,
) -> anyhow::Result<sqlx::Transaction<'_, sqlx::Sqlite>> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE bitwarden_org_policies SET id = id WHERE 0")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

/// `status IN (accepted, confirmed)` and not an owner or administrator: a
/// member the policies of their organization bind.
fn bound(alias: &str) -> String {
    format!(
        "{alias}.status IN ({}, {}) AND {alias}.member_type NOT IN ({}, {})",
        member_status::ACCEPTED,
        member_status::CONFIRMED,
        member_type::OWNER,
        member_type::ADMIN
    )
}

async fn enabled(tx: &mut SqliteConnection, org_id: &str, kind: i64) -> anyhow::Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM bitwarden_org_policies WHERE org_id = ? AND policy_type = ? AND enabled = 1",
    )
    .bind(org_id)
    .bind(kind)
    .fetch_optional(&mut *tx)
    .await?
    .is_some())
}

async fn has_two_step(tx: &mut SqliteConnection, user_id: &str) -> anyhow::Result<bool> {
    Ok(
        sqlx::query("SELECT 1 FROM bitwarden_two_factor WHERE user_id = ? AND enabled = 1")
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some(),
    )
}

/// Whether the account has accepted or joined an organization besides `org_id`.
async fn elsewhere(tx: &mut SqliteConnection, org_id: &str, user_id: &str) -> anyhow::Result<bool> {
    Ok(sqlx::query(&format!(
        "SELECT 1 FROM bitwarden_org_members o WHERE o.user_id = ? AND o.org_id <> ? \
         AND o.status IN ({}, {})",
        member_status::ACCEPTED,
        member_status::CONFIRMED
    ))
    .bind(user_id)
    .bind(org_id)
    .fetch_optional(&mut *tx)
    .await?
    .is_some())
}

/// Whether a single-organization policy of another organization binds the
/// account as one of its ordinary members.
pub(super) async fn bound_elsewhere(
    tx: &mut SqliteConnection,
    org_id: &str,
    user_id: &str,
) -> anyhow::Result<bool> {
    Ok(sqlx::query(&format!(
        "SELECT 1 FROM bitwarden_org_members o JOIN bitwarden_org_policies p \
         ON p.org_id = o.org_id AND p.enabled = 1 AND p.policy_type = {} \
         WHERE o.user_id = ? AND o.org_id <> ? AND {}",
        policy_type::SINGLE_ORGANIZATION,
        bound("o")
    ))
    .bind(user_id)
    .bind(org_id)
    .fetch_optional(&mut *tx)
    .await?
    .is_some())
}

/// The policy, if any, that keeps `user_id` from standing in `org_id` with
/// `role`. A policy binding the account in another organization applies to
/// every role; the organization's own apply to ordinary members only.
pub(super) async fn violation(
    tx: &mut SqliteConnection,
    org_id: &str,
    user_id: &str,
    role: i64,
) -> anyhow::Result<Option<PolicyViolation>> {
    if bound_elsewhere(tx, org_id, user_id).await? {
        return Ok(Some(PolicyViolation::SingleOrganization));
    }
    if matches!(role, member_type::OWNER | member_type::ADMIN) {
        return Ok(None);
    }
    if enabled(tx, org_id, policy_type::TWO_STEP_LOGIN).await? && !has_two_step(tx, user_id).await?
    {
        return Ok(Some(PolicyViolation::TwoStepLogin));
    }
    if enabled(tx, org_id, policy_type::SINGLE_ORGANIZATION).await?
        && elsewhere(tx, org_id, user_id).await?
    {
        return Ok(Some(PolicyViolation::SingleOrganization));
    }
    Ok(None)
}

/// Revoke the members of `org_id` that its enabled policy `kind` excludes.
/// Returns the accounts revoked.
async fn revoke_excluded(
    tx: &mut SqliteConnection,
    org_id: &str,
    kind: i64,
) -> anyhow::Result<Vec<String>> {
    let excluded = match kind {
        policy_type::TWO_STEP_LOGIN => {
            "NOT EXISTS (SELECT 1 FROM bitwarden_two_factor f \
             WHERE f.user_id = m.user_id AND f.enabled = 1)"
        }
        policy_type::SINGLE_ORGANIZATION => {
            "EXISTS (SELECT 1 FROM bitwarden_org_members o WHERE o.user_id = m.user_id \
             AND o.org_id <> m.org_id AND o.status IN (1, 2))"
        }
        _ => return Ok(Vec::new()),
    };
    let which = format!(
        "FROM bitwarden_org_members m WHERE m.org_id = ? AND m.user_id IS NOT NULL AND {} AND {excluded}",
        bound("m")
    );
    let users: Vec<String> = sqlx::query(&format!("SELECT m.user_id {which}"))
        .bind(org_id)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(|row| row.get("user_id"))
        .collect();
    for user in &users {
        sqlx::query(
            "UPDATE bitwarden_org_members SET status = ?, revision_at = ? \
             WHERE org_id = ? AND user_id = ?",
        )
        .bind(member_status::REVOKED)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(org_id)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    }
    Ok(users)
}

/// Revoke the ordinary members of the organizations an arriving or changed
/// account may no longer stand in. Returns how many were revoked.
pub(super) async fn revoke_violators(
    tx: &mut SqliteConnection,
    org_id: &str,
) -> anyhow::Result<usize> {
    let members: Vec<(String, String, i64)> = sqlx::query(&format!(
        "SELECT m.id, m.user_id, m.member_type FROM bitwarden_org_members m \
         WHERE m.org_id = ? AND m.user_id IS NOT NULL AND m.status IN ({}, {})",
        member_status::ACCEPTED,
        member_status::CONFIRMED
    ))
    .bind(org_id)
    .fetch_all(&mut *tx)
    .await?
    .iter()
    .map(|row| (row.get("id"), row.get("user_id"), row.get("member_type")))
    .collect();
    let mut revoked = 0;
    for (id, user, role) in members {
        if violation(tx, org_id, &user, role).await?.is_some() {
            sqlx::query(
                "UPDATE bitwarden_org_members SET status = ?, revision_at = ? WHERE id = ?",
            )
            .bind(member_status::REVOKED)
            .bind(bitwarden_timestamp(Utc::now()))
            .bind(id)
            .execute(&mut *tx)
            .await?;
            revoked += 1;
        }
    }
    Ok(revoked)
}

/// An account lost its last two-step provider: it leaves, as revoked, every
/// organization that requires one — in the transaction that removed it.
pub(super) async fn revoke_without_two_step(
    tx: &mut SqliteConnection,
    user_id: &str,
) -> anyhow::Result<()> {
    sqlx::query(&format!(
        "UPDATE bitwarden_org_members SET status = ?, revision_at = ? WHERE user_id = ? \
         AND {} AND org_id IN (SELECT org_id FROM bitwarden_org_policies \
         WHERE policy_type = {} AND enabled = 1)",
        bound("bitwarden_org_members"),
        policy_type::TWO_STEP_LOGIN
    ))
    .bind(member_status::REVOKED)
    .bind(bitwarden_timestamp(Utc::now()))
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

impl Db {
    /// Set a policy. Enabling two-step login or single organization revokes,
    /// in the same transaction, the ordinary members it excludes; the
    /// accounts revoked are returned so their clients can be told.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails; nothing is then changed.
    pub async fn bitwarden_put_policy_enforcing(
        &self,
        policy: &BitwardenPolicy,
    ) -> anyhow::Result<Vec<String>> {
        let mut tx = begin_write(&self.pool).await?;
        super::policies::put_policy(&mut tx, policy).await?;
        let revoked = if policy.enabled {
            revoke_excluded(&mut tx, &policy.org_id, policy.policy_type).await?
        } else {
            Vec::new()
        };
        tx.commit().await?;
        Ok(revoked)
    }

    /// Confirm an accepted member, unless a policy keeps them out.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_confirm_member_enforced(
        &self,
        org_id: &str,
        member_id: &str,
        key: &str,
    ) -> anyhow::Result<Result<bool, PolicyViolation>> {
        let mut tx = begin_write(&self.pool).await?;
        let member = sqlx::query(
            "SELECT user_id, member_type FROM bitwarden_org_members \
             WHERE id = ? AND org_id = ? AND status = ? AND user_id IS NOT NULL",
        )
        .bind(member_id)
        .bind(org_id)
        .bind(member_status::ACCEPTED)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(member) = member else {
            return Ok(Ok(false));
        };
        let user_id: String = member.get("user_id");
        if let Some(refused) =
            violation(&mut tx, org_id, &user_id, member.get("member_type")).await?
        {
            return Ok(Err(refused));
        }
        sqlx::query(
            "UPDATE bitwarden_org_members SET key = ?, status = ?, revision_at = ? \
             WHERE id = ? AND org_id = ?",
        )
        .bind(key)
        .bind(member_status::CONFIRMED)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(member_id)
        .bind(org_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Ok(true))
    }

    /// Restore a revoked member, first checking them as the confirmed
    /// member they will be again.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_restore_member_enforced(
        &self,
        member: &BitwardenOrgMember,
    ) -> anyhow::Result<Result<(), PolicyViolation>> {
        let mut tx = begin_write(&self.pool).await?;
        let stands = matches!(
            member.status,
            member_status::ACCEPTED | member_status::CONFIRMED
        );
        if let (true, Some(user_id)) = (stands, member.user_id.as_deref()) {
            if let Some(refused) =
                violation(&mut tx, &member.org_id, user_id, member.member_type).await?
            {
                return Ok(Err(refused));
            }
        }
        super::orgs::update_member(&mut tx, member).await?;
        tx.commit().await?;
        Ok(Ok(()))
    }

    /// Create an organization and its owner, unless a single-organization
    /// policy binds the creator.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_create_organization_enforced(
        &self,
        org: &BitwardenOrganization,
        owner: &BitwardenOrgMember,
        first_collection: Option<&BitwardenCollection>,
    ) -> anyhow::Result<Result<(), PolicyViolation>> {
        let mut tx = begin_write(&self.pool).await?;
        if let Some(user_id) = owner.user_id.as_deref() {
            if bound_elsewhere(&mut tx, &org.id, user_id).await? {
                return Ok(Err(PolicyViolation::SingleOrganization));
            }
        }
        insert_org(&mut tx, org).await?;
        insert_member(&mut tx, owner).await?;
        if let Some(collection) = first_collection {
            insert_collection(&mut tx, collection).await?;
        }
        tx.commit().await?;
        Ok(Ok(()))
    }
}
