//! Organizations and emergency contacts moving in from another server
//! (ADR 0148 §2, §5, §6), after the accounts they name have landed.
//!
//! A member whose account did not come across cannot keep the organization
//! key it held — that was wrapped to a key pair nobody here has. If an
//! account at the member's address exists here, the member is accepted (as
//! an invitation to an existing account is, with no mail) and waits for an
//! administrator to confirm them again; otherwise the membership waits as an
//! invitation that address claims when it registers. Emergency contacts are
//! treated the same way.

use super::ciphers::insert_cipher;
use super::collections::{insert_collection, write_access};
use super::emergency::{emergency_status, BitwardenEmergencyAccess};
use super::org_ciphers::put_mark;
use super::orgs::{insert_member, insert_org};
use super::{
    member_status, ArrivalOutcome, BitwardenCipher, BitwardenCollection, BitwardenCollectionAccess,
    BitwardenMark, BitwardenOrgMember, BitwardenOrganization, BitwardenPolicy,
};
use crate::Db;

/// One organization as it arrives, whole.
#[derive(Clone, Debug)]
pub struct BitwardenOrgArrival {
    pub org: BitwardenOrganization,
    pub members: Vec<BitwardenOrgMember>,
    pub collections: Vec<BitwardenCollection>,
    pub access: Vec<BitwardenCollectionAccess>,
    pub ciphers: Vec<BitwardenCipher>,
    /// `(cipher, collection)`.
    pub links: Vec<(String, String)>,
    /// `(cipher, user, mark)`: a member's own folder and favourite.
    pub marks: Vec<(String, String, BitwardenMark)>,
    pub policies: Vec<BitwardenPolicy>,
}

/// Where an account named by id or address stands here.
async fn resolve(
    tx: &mut sqlx::SqliteConnection,
    user_id: Option<&str>,
    email: &str,
) -> anyhow::Result<(Option<String>, bool)> {
    if let Some(id) = user_id {
        let same: Option<String> =
            sqlx::query_scalar("SELECT id FROM bitwarden_users WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        if same.is_some() {
            return Ok((same, true));
        }
    }
    let by_email: Option<String> =
        sqlx::query_scalar("SELECT id FROM bitwarden_users WHERE email = ?")
            .bind(email)
            .fetch_optional(&mut *tx)
            .await?;
    Ok((by_email, false))
}

/// The member as it can stand here.
async fn arriving_member(
    tx: &mut sqlx::SqliteConnection,
    member: &BitwardenOrgMember,
) -> anyhow::Result<BitwardenOrgMember> {
    let (user_id, same_account) = resolve(tx, member.user_id.as_deref(), &member.email).await?;
    let mut out = member.clone();
    out.user_id.clone_from(&user_id);
    if !same_account {
        out.key = None;
        out.reset_password_key = None;
        out.status = match (member.status, &user_id) {
            (member_status::REVOKED, _) => member_status::REVOKED,
            // An address with an account here is accepted at once, as an
            // invitation to one is on this server (there is no mail).
            (_, Some(_)) => member_status::ACCEPTED,
            (_, None) => member_status::INVITED,
        };
    }
    Ok(out)
}

/// Everything an arriving organization holds, in the open transaction.
async fn insert_contents(
    tx: &mut sqlx::SqliteConnection,
    arrival: &BitwardenOrgArrival,
) -> anyhow::Result<()> {
    insert_org(tx, &arrival.org).await?;
    for member in &arrival.members {
        let member = arriving_member(tx, member).await?;
        insert_member(tx, &member).await?;
    }
    for collection in &arrival.collections {
        insert_collection(tx, collection).await?;
    }
    write_access(tx, &arrival.access).await?;
    for cipher in &arrival.ciphers {
        insert_cipher(&mut *tx, cipher).await?;
    }
    for (cipher, collection) in &arrival.links {
        sqlx::query(
            "INSERT OR IGNORE INTO bitwarden_collection_ciphers (collection_id, cipher_id) \
                 VALUES (?, ?)",
        )
        .bind(collection)
        .bind(cipher)
        .execute(&mut *tx)
        .await?;
    }
    for policy in &arrival.policies {
        sqlx::query(
                "INSERT INTO bitwarden_org_policies (id, org_id, policy_type, enabled, data, \
                 revision_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, policy_type) DO NOTHING",
            )
            .bind(&policy.id)
            .bind(&arrival.org.id)
            .bind(policy.policy_type)
            .bind(i64::from(policy.enabled))
            .bind(&policy.data)
            .bind(super::accounts::bitwarden_timestamp(policy.revision_at))
            .execute(&mut *tx)
            .await?;
    }
    for (cipher, user, mark) in &arrival.marks {
        let present = sqlx::query("SELECT 1 FROM bitwarden_users WHERE id = ?")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
        if present.is_some() {
            put_mark(tx, cipher, user, mark).await?;
        }
    }
    Ok(())
}

impl Db {
    /// Write an arriving organization in one transaction. With `replace`, an
    /// organization already here under its id is replaced; without, it is
    /// left alone and `IdTaken` returned — as when one of its ciphers' ids
    /// is taken.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_arrive_organization(
        &self,
        arrival: &BitwardenOrgArrival,
        replace: bool,
    ) -> anyhow::Result<ArrivalOutcome> {
        let mut tx = self.pool.begin().await?;
        let exists = sqlx::query("SELECT 1 FROM bitwarden_organizations WHERE id = ?")
            .bind(&arrival.org.id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        if exists && !replace {
            return Ok(ArrivalOutcome::IdTaken);
        }
        if exists {
            sqlx::query("DELETE FROM bitwarden_organizations WHERE id = ?")
                .bind(&arrival.org.id)
                .execute(&mut *tx)
                .await?;
        }
        for cipher in &arrival.ciphers {
            let taken = sqlx::query("SELECT 1 FROM bitwarden_ciphers WHERE id = ?")
                .bind(&cipher.id)
                .fetch_optional(&mut *tx)
                .await?;
            if taken.is_some() {
                return Ok(ArrivalOutcome::IdTaken);
            }
        }
        insert_contents(&mut tx, arrival).await?;
        tx.commit().await?;
        Ok(if exists {
            ArrivalOutcome::Replaced
        } else {
            ArrivalOutcome::Created
        })
    }

    /// Record an arriving emergency contact, if its grantor is here. Returns
    /// `false`, and writes nothing, when the grantor is not or the record's
    /// id or grantor-and-address pair is taken.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn bitwarden_arrive_emergency_access(
        &self,
        access: &BitwardenEmergencyAccess,
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let grantor = sqlx::query("SELECT 1 FROM bitwarden_users WHERE id = ?")
            .bind(&access.grantor_id)
            .fetch_optional(&mut *tx)
            .await?;
        if grantor.is_none() {
            return Ok(false);
        }
        let (grantee, same_account) =
            resolve(&mut tx, access.grantee_id.as_deref(), &access.email).await?;
        let mut record = access.clone();
        record.grantee_id.clone_from(&grantee);
        if !same_account {
            record.key_encrypted = None;
            record.recovery_initiated_at = None;
            record.status = if grantee.is_some() {
                emergency_status::ACCEPTED
            } else {
                emergency_status::INVITED
            };
        }
        let done = sqlx::query(
            "INSERT INTO bitwarden_emergency_access (id, grantor_id, grantee_id, email, \
             key_encrypted, access_type, status, wait_time_days, recovery_initiated_at, \
             created_at, revision_at) SELECT ?,?,?,?,?,?,?,?,?,?,? \
             WHERE NOT EXISTS (SELECT 1 FROM bitwarden_emergency_access WHERE id = ?) \
             ON CONFLICT(grantor_id, email) DO NOTHING",
        )
        .bind(&record.id)
        .bind(&record.grantor_id)
        .bind(&record.grantee_id)
        .bind(&record.email)
        .bind(&record.key_encrypted)
        .bind(record.access_type)
        .bind(record.status)
        .bind(record.wait_time_days)
        .bind(
            record
                .recovery_initiated_at
                .map(super::accounts::bitwarden_timestamp),
        )
        .bind(super::accounts::bitwarden_timestamp(record.created_at))
        .bind(super::accounts::bitwarden_timestamp(record.revision_at))
        .bind(&record.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(done.rows_affected() == 1)
    }
}
