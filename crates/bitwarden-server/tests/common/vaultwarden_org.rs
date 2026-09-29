//! The organization in the vaultwarden fixture, as vaultwarden's tables hold
//! one: the key wrapped to the owner's public key per member, a collection,
//! who reaches it, and an emergency contact.

use sqlx::sqlite::SqlitePool;

use super::client::encrypt;
use super::vaultwarden::{exec, Keys, AT, COLLECTION, ORG, ORG_ITEM, USER};

/// The organization: the account owns it, with the key wrapped to its
/// public key; the invited address is a member waiting; one collection
/// holds the organization's item, which the owner has made a favourite; and
/// the account names an emergency contact who never registered.
pub async fn insert_organization(pool: &SqlitePool, keys: &Keys, public: &str) {
    let akey = super::orgs::rsa_wrap(public, &keys.org_key.to_bytes());
    sqlx::query(
        "INSERT INTO organizations VALUES (?, 'Family', 'billing@example.test', NULL, NULL)",
    )
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    for (uuid, user, akey, status, atype) in [
        ("member-owner", USER, akey.as_str(), 2_i64, 0_i64),
        ("member-invited", "invited", "", 0, 2),
    ] {
        sqlx::query(
            "INSERT INTO users_organizations (uuid, user_uuid, org_uuid, access_all, akey, status, \
             atype) VALUES (?, ?, ?, 0, ?, ?, ?)",
        )
        .bind(uuid)
        .bind(user)
        .bind(ORG)
        .bind(akey)
        .bind(status)
        .bind(atype)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO collections VALUES (?, ?, ?, NULL)")
        .bind(COLLECTION)
        .bind(ORG)
        .bind(encrypt(&keys.org_key, b"Household"))
        .execute(pool)
        .await
        .unwrap();
    for sql in [
        format!("INSERT INTO users_collections VALUES ('{USER}', '{COLLECTION}', 0, 0, 1)"),
        format!("INSERT INTO ciphers_collections VALUES ('{ORG_ITEM}', '{COLLECTION}')"),
        format!("INSERT INTO favorites VALUES ('{USER}', '{ORG_ITEM}')"),
        format!(
            "INSERT INTO emergency_access (uuid, grantor_uuid, email, atype, status, \
             wait_time_days, updated_at, created_at) VALUES ('ea-1', '{USER}', \
             'contact@example.test', 1, 0, 3, '{AT}', '{AT}')"
        ),
    ] {
        exec(pool, &sql).await;
    }
}
