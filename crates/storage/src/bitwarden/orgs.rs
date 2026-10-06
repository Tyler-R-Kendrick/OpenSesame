//! Organizations behind the Bitwarden-compatible server (ADR 0148): the
//! organization, and its members with their status, role and wrapped key.
//!
//! A member's `key` is the organization key encrypted to that member's public
//! key by whoever confirmed them; the server cannot open it. An invitation to
//! an address with no account yet waits (`Invited`) and is claimed when that
//! address registers.

use chrono::{DateTime, Utc};
use sqlx::sqlite::SqliteRow;
use sqlx::Row as _;

use super::accounts::{bitwarden_timestamp, parse_bitwarden_timestamp};
use super::collections::BitwardenCollection;
use crate::Db;

/// Member statuses, as the wire enum carries them.
pub mod member_status {
    pub const REVOKED: i64 = -1;
    pub const INVITED: i64 = 0;
    pub const ACCEPTED: i64 = 1;
    pub const CONFIRMED: i64 = 2;
}

/// Member roles, as the wire enum carries them.
pub mod member_type {
    pub const OWNER: i64 = 0;
    pub const ADMIN: i64 = 1;
    pub const USER: i64 = 2;
    pub const MANAGER: i64 = 3;
    pub const CUSTOM: i64 = 4;
}

#[derive(Clone, PartialEq, Eq)]
pub struct BitwardenOrganization {
    pub id: String,
    pub name: String,
    pub billing_email: String,
    pub plan_type: i64,
    pub seats: Option<i64>,
    /// The organization's RSA public key, and its private key wrapped under
    /// the organization key.
    pub public_key: Option<String>,
    pub private_key: Option<String>,
    pub created_at: DateTime<Utc>,
    pub revision_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitwardenOrgMember {
    pub id: String,
    pub org_id: String,
    pub user_id: Option<String>,
    pub email: String,
    pub key: Option<String>,
    pub status: i64,
    pub member_type: i64,
    pub access_all: bool,
    /// A custom role's permissions as the client sent them (JSON).
    pub permissions: Option<String>,
    pub reset_password_key: Option<String>,
    pub external_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub revision_at: DateTime<Utc>,
}

fn org_from(row: &SqliteRow) -> anyhow::Result<BitwardenOrganization> {
    Ok(BitwardenOrganization {
        id: row.get("id"),
        name: row.get("name"),
        billing_email: row.get("billing_email"),
        plan_type: row.get("plan_type"),
        seats: row.get("seats"),
        public_key: row.get("public_key"),
        private_key: row.get("private_key"),
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
    })
}

fn member_from(row: &SqliteRow) -> anyhow::Result<BitwardenOrgMember> {
    Ok(BitwardenOrgMember {
        id: row.get("id"),
        org_id: row.get("org_id"),
        user_id: row.get("user_id"),
        email: row.get("email"),
        key: row.get("key"),
        status: row.get("status"),
        member_type: row.get("member_type"),
        access_all: row.get::<i64, _>("access_all") != 0,
        permissions: row.get("permissions"),
        reset_password_key: row.get("reset_password_key"),
        external_id: row.get("external_id"),
        created_at: parse_bitwarden_timestamp(&row.get::<String, _>("created_at"))?,
        revision_at: parse_bitwarden_timestamp(&row.get::<String, _>("revision_at"))?,
    })
}

const ORG_COLUMNS: &str = "id, name, billing_email, plan_type, seats, public_key, private_key, \
     created_at, revision_at";
const MEMBER_COLUMNS: &str = "id, org_id, user_id, email, key, status, member_type, access_all, \
     permissions, reset_password_key, external_id, created_at, revision_at";

pub(super) async fn insert_member(
    tx: &mut sqlx::SqliteConnection,
    member: &BitwardenOrgMember,
) -> anyhow::Result<bool> {
    // Formatting interpolates only fixed column constants; external values are bound.
    // ast-grep-ignore: sql-format-injection
    let done = sqlx::query(&format!(
        "INSERT INTO bitwarden_org_members ({MEMBER_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) \
         ON CONFLICT(org_id, email) DO NOTHING"
    ))
    .bind(&member.id)
    .bind(&member.org_id)
    .bind(&member.user_id)
    .bind(&member.email)
    .bind(&member.key)
    .bind(member.status)
    .bind(member.member_type)
    .bind(i64::from(member.access_all))
    .bind(&member.permissions)
    .bind(&member.reset_password_key)
    .bind(&member.external_id)
    .bind(bitwarden_timestamp(member.created_at))
    .bind(bitwarden_timestamp(member.revision_at))
    .execute(&mut *tx)
    .await?;
    Ok(done.rows_affected() == 1)
}

pub(super) async fn insert_org(
    tx: &mut sqlx::SqliteConnection,
    org: &BitwardenOrganization,
) -> anyhow::Result<()> {
    // Formatting interpolates only fixed column constants; external values are bound.
    // ast-grep-ignore: sql-format-injection
    sqlx::query(&format!(
        "INSERT INTO bitwarden_organizations ({ORG_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)"
    ))
    .bind(&org.id)
    .bind(&org.name)
    .bind(&org.billing_email)
    .bind(org.plan_type)
    .bind(org.seats)
    .bind(&org.public_key)
    .bind(&org.private_key)
    .bind(bitwarden_timestamp(org.created_at))
    .bind(bitwarden_timestamp(org.revision_at))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

impl Db {
    /// Create an organization with its owner and, if given, its first
    /// collection, in one transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_create_organization(
        &self,
        org: &BitwardenOrganization,
        owner: &BitwardenOrgMember,
        first_collection: Option<&BitwardenCollection>,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        insert_org(&mut tx, org).await?;
        insert_member(&mut tx, owner).await?;
        if let Some(collection) = first_collection {
            super::collections::insert_collection(&mut tx, collection).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// One organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or the row is malformed.
    pub async fn bitwarden_organization(
        &self,
        id: &str,
    ) -> anyhow::Result<Option<BitwardenOrganization>> {
        // Formatting interpolates only fixed column constants; external values are bound.
        // ast-grep-ignore: sql-format-injection
        let row = sqlx::query(&format!(
            "SELECT {ORG_COLUMNS} FROM bitwarden_organizations WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(org_from).transpose()
    }

    /// Rename an organization or change its billing address; set its key
    /// pair if it has none.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_update_organization(
        &self,
        org: &BitwardenOrganization,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE bitwarden_organizations SET name = ?, billing_email = ?, \
             public_key = COALESCE(public_key, ?), private_key = COALESCE(private_key, ?), \
             revision_at = ? WHERE id = ?",
        )
        .bind(&org.name)
        .bind(&org.billing_email)
        .bind(&org.public_key)
        .bind(&org.private_key)
        .bind(bitwarden_timestamp(org.revision_at))
        .bind(&org.id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete an organization with its members, collections and ciphers.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_delete_organization(&self, id: &str) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM bitwarden_organizations WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Every member of an organization, in any status.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_org_members(
        &self,
        org_id: &str,
    ) -> anyhow::Result<Vec<BitwardenOrgMember>> {
        // Formatting interpolates only fixed column constants; external values are bound.
        // ast-grep-ignore: sql-format-injection
        let rows = sqlx::query(&format!(
            "SELECT {MEMBER_COLUMNS} FROM bitwarden_org_members WHERE org_id = ? ORDER BY created_at, id"
        ))
        .bind(org_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(member_from).collect()
    }

    /// Every organization the account belongs to, with its membership, in any
    /// status.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a row is malformed.
    pub async fn bitwarden_memberships(
        &self,
        user_id: &str,
    ) -> anyhow::Result<Vec<(BitwardenOrgMember, BitwardenOrganization)>> {
        // Formatting interpolates only fixed column constants; external values are bound.
        // ast-grep-ignore: sql-format-injection
        let members = sqlx::query(&format!(
            "SELECT {MEMBER_COLUMNS} FROM bitwarden_org_members WHERE user_id = ? ORDER BY created_at"
        ))
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(members.len());
        for row in &members {
            let member = member_from(row)?;
            if let Some(org) = self.bitwarden_organization(&member.org_id).await? {
                out.push((member, org));
            }
        }
        Ok(out)
    }

    /// Confirm an accepted member with the organization key wrapped for them.
    /// Only an `Accepted` member can be confirmed, once.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_confirm_member(
        &self,
        org_id: &str,
        member_id: &str,
        key: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query(
            "UPDATE bitwarden_org_members SET key = ?, status = ?, revision_at = ? \
             WHERE id = ? AND org_id = ? AND status = ? AND user_id IS NOT NULL",
        )
        .bind(key)
        .bind(member_status::CONFIRMED)
        .bind(bitwarden_timestamp(Utc::now()))
        .bind(member_id)
        .bind(org_id)
        .bind(member_status::ACCEPTED)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }

    /// Change a member's role, access-all flag, permissions or status.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_update_member(&self, member: &BitwardenOrgMember) -> anyhow::Result<()> {
        let mut conn = self.pool.acquire().await?;
        update_member(&mut conn, member).await
    }

    /// Remove a member.
    ///
    /// # Errors
    ///
    /// Returns an error when the write fails.
    pub async fn bitwarden_remove_member(
        &self,
        org_id: &str,
        member_id: &str,
    ) -> anyhow::Result<bool> {
        let done = sqlx::query("DELETE FROM bitwarden_org_members WHERE id = ? AND org_id = ?")
            .bind(member_id)
            .bind(org_id)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected() == 1)
    }
}

pub(super) async fn update_member(
    conn: &mut sqlx::SqliteConnection,
    member: &BitwardenOrgMember,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE bitwarden_org_members SET member_type = ?, access_all = ?, permissions = ?, \
         status = ?, reset_password_key = ?, revision_at = ? WHERE id = ? AND org_id = ?",
    )
    .bind(member.member_type)
    .bind(i64::from(member.access_all))
    .bind(&member.permissions)
    .bind(member.status)
    .bind(&member.reset_password_key)
    .bind(bitwarden_timestamp(Utc::now()))
    .bind(&member.id)
    .bind(&member.org_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
