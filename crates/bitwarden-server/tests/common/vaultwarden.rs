//! A vaultwarden server's database, as its `SQLite` migrations leave it, with
//! accounts whose keys are made as any Bitwarden client makes them.

use opensesame_provider_bitwarden::{Kdf, MasterKey, SymmetricKey, MIN_PBKDF2_ITERATIONS};
use rand::RngCore as _;
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use zeroize::Zeroizing;

use super::client::encrypt;

/// `(public key, private key wrapped under the user key)`, as clients make them.
fn key_pair(user_key: &SymmetricKey) -> (String, String) {
    use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der, PublicKeyX509Der};
    use aws_lc_rs::rsa::{KeyPair, KeySize};
    use aws_lc_rs::signature::KeyPair as _;
    use base64::Engine as _;
    let pair = KeyPair::generate(KeySize::Rsa2048).unwrap();
    let private: Pkcs8V1Der = pair.as_der().unwrap();
    let public: PublicKeyX509Der = pair.public_key().as_der().unwrap();
    (
        base64::engine::general_purpose::STANDARD.encode(public.as_ref()),
        encrypt(user_key, private.as_ref()),
    )
}

pub const PASSWORD: &str = "correct horse battery staple";
pub const KDF: Kdf = Kdf::Pbkdf2 {
    iterations: MIN_PBKDF2_ITERATIONS,
};

/// An account's keys, made as any Bitwarden client makes them.
pub struct Keys {
    pub login_hash: String,
    pub wrapped_user_key: String,
    pub user_key: SymmetricKey,
}

pub fn keys(email: &str) -> Keys {
    let master = MasterKey::derive(PASSWORD.as_bytes(), email, &KDF).unwrap();
    let mut raw = Zeroizing::new(vec![0_u8; 64]);
    rand::rngs::OsRng.fill_bytes(&mut raw);
    Keys {
        login_hash: master.password_hash_b64(PASSWORD.as_bytes()),
        wrapped_user_key: encrypt(&master.stretch(), &raw),
        user_key: SymmetricKey::from_bytes(&raw).unwrap(),
    }
}

/// vaultwarden's tables, as its `SQLite` migrations leave them today.
const VAULTWARDEN_SCHEMA: &str = r"
CREATE TABLE users (uuid TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, password_hash BLOB NOT NULL, salt BLOB NOT NULL,
  password_iterations INTEGER NOT NULL, password_hint TEXT, akey TEXT NOT NULL,
  private_key TEXT, public_key TEXT, totp_secret TEXT, totp_recover TEXT,
  security_stamp TEXT NOT NULL, equivalent_domains TEXT NOT NULL DEFAULT '[]',
  excluded_globals TEXT NOT NULL DEFAULT '[]', client_kdf_type INTEGER NOT NULL DEFAULT 0,
  client_kdf_iter INTEGER NOT NULL DEFAULT 100000, client_kdf_memory INTEGER,
  client_kdf_parallelism INTEGER, api_key TEXT);
CREATE TABLE organizations (uuid TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE ciphers (uuid TEXT PRIMARY KEY, created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL, user_uuid TEXT, organization_uuid TEXT, key TEXT,
  atype INTEGER NOT NULL, name TEXT NOT NULL, notes TEXT, fields TEXT, data TEXT NOT NULL,
  password_history TEXT, deleted_at DATETIME, reprompt INTEGER);
CREATE TABLE folders (uuid TEXT PRIMARY KEY, created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL, user_uuid TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE folders_ciphers (cipher_uuid TEXT NOT NULL, folder_uuid TEXT NOT NULL,
  PRIMARY KEY (cipher_uuid, folder_uuid));
CREATE TABLE favorites (user_uuid TEXT NOT NULL, cipher_uuid TEXT NOT NULL,
  PRIMARY KEY (user_uuid, cipher_uuid));
CREATE TABLE attachments (id TEXT PRIMARY KEY, cipher_uuid TEXT NOT NULL,
  file_name TEXT NOT NULL, file_size BIGINT NOT NULL, akey TEXT);
CREATE TABLE twofactor (uuid TEXT PRIMARY KEY, user_uuid TEXT NOT NULL, atype INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL, data TEXT NOT NULL, last_used BIGINT NOT NULL DEFAULT 0);
";

pub const EMAIL: &str = "vw@example.test";
pub const USER: &str = "5f0cfb2b-6d56-4c1b-9d4a-0f2d0c8c9a11";

/// The account's sign-in methods as vaultwarden holds them.
pub const API_KEY: &str = "vwApiKey0123456789abcdefghijkl";
pub const RECOVERY: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
pub const AUTHENTICATOR_KEY: &str = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

pub const LOGIN: &str = "0c6f1d2a-4b1e-4a5c-9d3f-2e8b7a6c5d41";
pub const NOTE: &str = "1d7e2f3b-5c2f-4b6d-8e4a-3f9c8b7d6e52";
const FOLDER: &str = "2e8f3a4c-6d3a-4c7e-9f5b-4a0d9c8e7f63";
const ORG_ITEM: &str = "3f9a4b5d-7e4b-4d8f-8a6c-5b1e0d9f8a74";
const AT: &str = "2024-05-06 07:08:09.123456";

/// One `ciphers` row.
struct CipherRow<'a> {
    uuid: &'a str,
    user: Option<&'a str>,
    org: Option<&'a str>,
    atype: i64,
    name: String,
    data: Value,
    deleted: Option<&'a str>,
}

async fn exec(pool: &SqlitePool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

async fn insert_users(pool: &SqlitePool, keys: &Keys) {
    // vaultwarden: PBKDF2-SHA256 over the login hash string, 64-byte salt.
    let salt: Vec<u8> = (0..64_u8).collect();
    let mut hash = [0_u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(keys.login_hash.as_bytes(), &salt, 1_000, &mut hash);
    let users: [(&str, bool, &str, &[u8], &str); 3] = [
        (USER, true, EMAIL, &hash, keys.wrapped_user_key.as_str()),
        ("invited", true, "invited@example.test", b"", ""),
        ("disabled", false, "off@example.test", &hash, "2.a|b|c"),
    ];
    for (uuid, enabled, email, password_hash, akey) in users {
        sqlx::query(
            "INSERT INTO users (uuid, enabled, created_at, updated_at, email, name, \
             password_hash, salt, password_iterations, akey, security_stamp, client_kdf_type, \
             client_kdf_iter, password_hint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(uuid)
        .bind(enabled)
        .bind(AT)
        .bind(AT)
        .bind(email)
        .bind("Vault Warden")
        .bind(password_hash)
        .bind(&salt[..])
        .bind(1_000_i64)
        .bind(akey)
        .bind("stamp")
        .bind(0_i64)
        .bind(i64::from(MIN_PBKDF2_ITERATIONS))
        .bind("the horse")
        .execute(pool)
        .await
        .unwrap();
    }
    // Every client since 2018 gives an account an RSA pair at registration.
    let (public, private) = key_pair(&keys.user_key);
    sqlx::query(
        "UPDATE users SET public_key = ?, private_key = ?, api_key = ?, totp_recover = ? \
         WHERE uuid = ?",
    )
    .bind(public)
    .bind(private)
    .bind(API_KEY)
    .bind(RECOVERY.to_ascii_lowercase())
    .bind(USER)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_ciphers(pool: &SqlitePool, keys: &Keys) {
    let enc = |plain: &str| encrypt(&keys.user_key, plain.as_bytes());
    sqlx::query("INSERT INTO folders VALUES (?, ?, ?, ?, ?)")
        .bind(FOLDER)
        .bind(AT)
        .bind(AT)
        .bind(USER)
        .bind(enc("Money"))
        .execute(pool)
        .await
        .unwrap();
    let legacy_login = json!({
        "Name": enc("stale copy"),
        "Username": enc("alice"),
        "Password": enc("hunter2"),
        "Uris": [{"Uri": enc("https://bank.example"), "Match": null, "Response": null}],
    });
    let note = json!({"type": 0});
    let rows = [
        CipherRow {
            uuid: LOGIN,
            user: Some(USER),
            org: None,
            atype: 1,
            name: enc("Bank"),
            data: legacy_login,
            deleted: None,
        },
        CipherRow {
            uuid: NOTE,
            user: Some(USER),
            org: None,
            atype: 2,
            name: enc("Old note"),
            data: note.clone(),
            deleted: Some(AT),
        },
        CipherRow {
            uuid: ORG_ITEM,
            user: None,
            org: Some("org"),
            atype: 2,
            name: enc("Shared"),
            data: note,
            deleted: None,
        },
    ];
    for row in rows {
        sqlx::query(
            "INSERT INTO ciphers (uuid, created_at, updated_at, user_uuid, organization_uuid, \
             atype, name, data, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(row.uuid)
        .bind(AT)
        .bind(AT)
        .bind(row.user)
        .bind(row.org)
        .bind(row.atype)
        .bind(row.name)
        .bind(row.data.to_string())
        .bind(row.deleted)
        .execute(pool)
        .await
        .unwrap();
    }
    exec(
        pool,
        &format!("INSERT INTO folders_ciphers VALUES ('{LOGIN}', '{FOLDER}')"),
    )
    .await;
    exec(
        pool,
        &format!("INSERT INTO favorites VALUES ('{USER}', '{LOGIN}')"),
    )
    .await;
    exec(
        pool,
        &format!("INSERT INTO attachments VALUES ('att', '{LOGIN}', 'x', 10, NULL)"),
    )
    .await;
    exec(pool, "INSERT INTO organizations VALUES ('org', 'Family')").await;
}

/// A vaultwarden database with one registered account, one invited, one
/// disabled; a login (legacy `PascalCase` payload, in a folder, a favourite,
/// with an attachment), a trashed note, and an organization item.
pub async fn fixture(path: &std::path::Path) -> Keys {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    for statement in VAULTWARDEN_SCHEMA
        .split(';')
        .filter(|s| !s.trim().is_empty())
    {
        exec(&pool, statement).await;
    }
    let keys = keys(EMAIL);
    insert_users(&pool, &keys).await;
    insert_ciphers(&pool, &keys).await;
    pool.close().await;
    keys
}

/// Turn two-step login on for the fixture account, as vaultwarden stores it:
/// an authenticator (which moves) and email (counted, not moved).
pub async fn enable_two_step(path: &std::path::Path) {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(path))
        .await
        .unwrap();
    let pool = &pool;
    for (uuid, atype, data) in [("tf-0", 0, AUTHENTICATOR_KEY), ("tf-1", 1, "{}")] {
        sqlx::query("INSERT INTO twofactor VALUES (?, ?, ?, 1, ?, 0)")
            .bind(uuid)
            .bind(USER)
            .bind(atype)
            .bind(data)
            .execute(pool)
            .await
            .unwrap();
    }
    pool.close().await;
}
