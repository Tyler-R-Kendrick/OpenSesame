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
        (
            "7d3e8f9b-1c8f-4d2a-8eaa-9f5c4b3d2e18",
            USER,
            akey.as_str(),
            2_i64,
            0_i64,
        ),
        ("8e4f9aac-2d9a-4e3b-9fbb-a06d5c4e3f29", "invited", "", 0, 2),
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
            "INSERT INTO org_policies VALUES ('6c2d7e8a-0b7e-4c1f-9d9f-8e4b3a2c1d07', '{ORG}', 2, 1, \
             '{{\"minLength\":20}}')"
        ),
        format!(
            "INSERT INTO emergency_access (uuid, grantor_uuid, email, atype, status, \
             wait_time_days, updated_at, created_at) VALUES ('9f5aabbd-3eab-4f4c-8acc-b17e6d5f4a3a', '{USER}', \
             'contact@example.test', 1, 0, 3, '{AT}', '{AT}')"
        ),
    ] {
        exec(pool, &sql).await;
    }
}
