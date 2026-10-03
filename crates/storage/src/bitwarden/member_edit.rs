//! Changes to who holds a seat in an organization, decided as they commit
//! (ADR 0148 §9): a role edit, an invitation to an existing account, and the
//! claim of a waiting invitation. Each takes the write lock before it reads,
//! and reads the member's standing from the row, never from a caller's copy.

use chrono::Utc;
use sqlx::Row as _;

use super::accounts::bitwarden_timestamp;
use super::orgs::insert_member;
use super::policy_rules::{begin_write, bound_elsewhere, violation};
use super::{member_status, member_type, BitwardenOrgMember, PolicyViolation};
use crate::Db;

fn runs(role: i64) -> bool {
    matches!(role, member_type::OWNER | member_type::ADMIN)
}

/// Whether another organization's single-organization policy binds the
/// account out of `org_id`; an address with no account yet is never barred.
async fn barred(
    tx: &mut sqlx::SqliteConnection,
    org_id: &str,
    user_id: Option<&str>,
) -> anyhow::Result<bool> {
    match user_id {
        Some(user_id) => bound_elsewhere(tx, org_id, user_id).await,
        None => Ok(false),
    }
}

impl Db {
    /// Change a member's role, access-all flag and permissions — never their
    /// status, which a concurrent revocation may have just changed. A
    /// demotion from owner or administrator is checked as the member will
    /// stand: refused when a policy would exclude them as an ordinary one.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_edit_member_enforced(
        &self,
        member: &BitwardenOrgMember,
    ) -> anyhow::Result<Result<(), PolicyViolation>> {
        let mut tx = begin_write(&self.pool).await?;
        let current = sqlx::query(
            "SELECT status, member_type, user_id FROM bitwarden_org_members \
             WHERE id = ? AND org_id = ?",
        )
        .bind(&member.id)
        .bind(&member.org_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(current) = current else {
            return Ok(Ok(()));
        };
        let status: i64 = current.get("status");
        let was: i64 = current.get("member_type");
        let user_id: Option<String> = current.get("user_id");
        let stands = matches!(status, member_status::ACCEPTED | member_status::CONFIRMED);
        if let (true, true, false, Some(user_id)) =
            (stands, runs(was), runs(member.member_type), user_id)
        {
            if let Some(refused) =
                violation(&mut tx, &member.org_id, &user_id, member.member_type).await?
            {
                return Ok(Err(refused));
            }
        }
        sqlx::query(
            "UPDATE bitwarden_org_members SET member_type = ?, access_all = ?, \
             permissions = ?, revision_at = ? WHERE id = ? AND org_id = ?",
        )
        .bind(member.member_type)
        .bind(i64::from(member.access_all))
        .bind(&member.permissions)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(&member.id)
        .bind(&member.org_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Ok(()))
    }

    /// Add members; one whose email is already a member is skipped, and so
    /// is an existing account that a single-organization policy of another
    /// organization binds there. Returns the ones added.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_add_members(
        &self,
        members: &[BitwardenOrgMember],
    ) -> anyhow::Result<Vec<String>> {
        let mut tx = begin_write(&self.pool).await?;
        let mut added = Vec::new();
        for member in members {
            if barred(&mut tx, &member.org_id, member.user_id.as_deref()).await? {
                continue;
            }
            if insert_member(&mut tx, member).await? {
                added.push(member.id.clone());
            }
        }
        tx.commit().await?;
        Ok(added)
    }

    /// Claim every invitation waiting for `email` for the account that now
    /// has it: they become accepted, awaiting an administrator's
    /// confirmation. An invitation from an organization the account is
    /// bound out of by another's single-organization policy keeps waiting.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_claim_invitations(
        &self,
        user_id: &str,
        email: &str,
    ) -> anyhow::Result<u64> {
        let mut tx = begin_write(&self.pool).await?;
        let waiting = sqlx::query(
            "SELECT id, org_id FROM bitwarden_org_members \
             WHERE email = ? AND user_id IS NULL AND status = ?",
        )
        .bind(email)
        .bind(member_status::INVITED)
        .fetch_all(&mut *tx)
        .await?;
        let mut claimed = 0;
        for row in &waiting {
            let org_id: String = row.get("org_id");
            if barred(&mut tx, &org_id, Some(user_id)).await? {
                continue;
            }
            let id: String = row.get("id");
            claimed += sqlx::query(
                "UPDATE bitwarden_org_members SET user_id = ?, status = ?, revision_at = ? \
                 WHERE id = ?",
            )
            .bind(user_id)
            .bind(member_status::ACCEPTED)
            .bind(bitwarden_timestamp(Utc::now()))
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            // One seat at a time: the next invitation sees this one.
        }
        tx.commit().await?;
        Ok(claimed)
    }
}
