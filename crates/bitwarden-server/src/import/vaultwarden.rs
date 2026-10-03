//! Reading a vaultwarden server's `SQLite` database (ADR 0148 §2).
//!
//! The file is opened read-only and only ever `SELECT`ed. vaultwarden's
//! schema has grown over the years, so each column this reads is looked up
//! first and read as `NULL` where an older server never had it.
//!
//! What moves, per registered account: the KDF choice, the wrapped user key,
//! the key pair, the server hash (PBKDF2-SHA256 in raw columns, written as a
//! record the registry verifies once and upgrades), folders, favourites,
//! trash, and every personal cipher. Then, server-wide: every organization
//! and every emergency contact (`orgs`). What stays behind is counted.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use chrono::Utc;
use opensesame_storage::bitwarden::{BitwardenArrival, BitwardenKdf, BitwardenUser};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};

mod emergency;
mod files;
mod orgs;
mod rows;
mod sign_in;

use rows::{blob, int, json_column, text, timestamp, Schema};

use super::{
    cipher, folder, keep_known_folders, leave, Arrival, CipherDates, LeftBehind, Skipped, Source,
};
use crate::hashing::pbkdf2_sha256_record;
use crate::wire::cipher::type_member;

/// The columns read from `users`, in order.
const USER_COLUMNS: &[&str] = &[
    "uuid",
    "enabled",
    "email",
    "name",
    "password_hash",
    "salt",
    "password_iterations",
    "password_hint",
    "akey",
    "private_key",
    "public_key",
    "security_stamp",
    "client_kdf_type",
    "client_kdf_iter",
    "client_kdf_memory",
    "client_kdf_parallelism",
    "created_at",
    "updated_at",
    "api_key",
    "totp_recover",
];

const CIPHER_COLUMNS: &[&str] = &[
    "uuid",
    "created_at",
    "updated_at",
    "key",
    "atype",
    "name",
    "notes",
    "fields",
    "data",
    "password_history",
    "deleted_at",
    "reprompt",
];

/// Members the type object may repeat from the cipher itself (older servers
/// stored them there too); the cipher's own columns win.
const CIPHER_LEVEL: &[&str] = &["name", "notes", "fields", "passwordHistory", "response"];

/// The account a `users` row describes, or why it cannot move.
fn user_from(row: &SqliteRow) -> Result<BitwardenUser, Skipped> {
    let email = text(row, "email")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let skip = |reason: &str| Skipped {
        email: email.clone(),
        reason: reason.to_owned(),
    };
    if int(row, "enabled") == Some(0) {
        return Err(skip("disabled on the vaultwarden server"));
    }
    let hash = blob(row, "password_hash");
    let salt = blob(row, "salt");
    let user_key = text(row, "akey");
    if hash.is_empty() || user_key.is_none() {
        return Err(skip(
            "invited, never registered: there is no master password",
        ));
    }
    let iterations = int(row, "password_iterations")
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0);
    let (Some(iterations), false) = (iterations, salt.is_empty()) else {
        return Err(skip("its server password hash is unreadable"));
    };
    let kdf_type = int(row, "client_kdf_type").unwrap_or(0);
    let now = Utc::now();
    let created = timestamp(text(row, "created_at")).unwrap_or(now);
    Ok(BitwardenUser {
        id: text(row, "uuid").ok_or_else(|| skip("it has no id"))?,
        email: email.clone(),
        name: text(row, "name"),
        master_password_hash: pbkdf2_sha256_record(iterations, &salt, &hash),
        master_password_hint: text(row, "password_hint"),
        kdf: BitwardenKdf {
            kdf_type,
            iterations: int(row, "client_kdf_iter").unwrap_or(100_000),
            memory: int(row, "client_kdf_memory").filter(|_| kdf_type == 1),
            parallelism: int(row, "client_kdf_parallelism").filter(|_| kdf_type == 1),
        },
        user_key: user_key.unwrap_or_default(),
        user_key_id: None,
        public_key: text(row, "public_key"),
        private_key: text(row, "private_key"),
        security_stamp: text(row, "security_stamp")
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        culture: "en-US".to_owned(),
        created_at: created,
        revision_at: timestamp(text(row, "updated_at")).unwrap_or(created),
    })
}

/// A personal cipher row as the request its client would have sent.
fn cipher_request(row: &SqliteRow, folder_id: Option<&String>, favorite: bool) -> Option<Value> {
    let cipher_type = int(row, "atype")?;
    let member = type_member(cipher_type)?;
    let mut payload = json_column(row, "data");
    if let Value::Object(map) = &mut payload {
        for key in CIPHER_LEVEL {
            map.remove(*key);
        }
        if let Some(Value::Array(uris)) = map.get_mut("uris") {
            for uri in uris.iter_mut().filter_map(Value::as_object_mut) {
                uri.remove("response");
            }
        }
    }
    Some(json!({
        "type": cipher_type,
        "name": text(row, "name"),
        "notes": text(row, "notes"),
        "key": text(row, "key"),
        "reprompt": int(row, "reprompt").unwrap_or(0),
        "fields": json_column(row, "fields"),
        "passwordHistory": json_column(row, "password_history"),
        member: payload,
        "folderId": folder_id,
        "favorite": favorite,
    }))
}

struct Reader {
    pool: SqlitePool,
    schema: Schema,
    /// vaultwarden's data folder, which holds `attachments/` and `sends/`.
    data: PathBuf,
}

impl Reader {
    async fn pairs(
        &self,
        table: &str,
        sql: &str,
        user: &str,
    ) -> anyhow::Result<Vec<(String, String)>> {
        if !self.schema.tables.contains(table) {
            return Ok(Vec::new());
        }
        Ok(sqlx::query_as(sql).bind(user).fetch_all(&self.pool).await?)
    }

    async fn folders(
        &self,
        user: &BitwardenUser,
        left: &mut LeftBehind,
    ) -> anyhow::Result<Vec<opensesame_storage::bitwarden::BitwardenFolder>> {
        let id = &user.id;
        let mut folders = Vec::new();
        let rows = sqlx::query(
            "SELECT uuid, name, created_at, updated_at FROM folders WHERE user_uuid = ?",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        for row in &rows {
            let created = timestamp(text(row, "created_at")).unwrap_or(user.created_at);
            let revised = timestamp(text(row, "updated_at")).unwrap_or(created);
            let (Some(folder_id), Some(name)) = (text(row, "uuid"), text(row, "name")) else {
                leave(left, "unreadable folders", 1);
                continue;
            };
            match folder(id, &folder_id, &name, created, revised) {
                Some(folder) => folders.push(folder),
                None => leave(left, "unreadable folders", 1),
            }
        }
        Ok(folders)
    }

    async fn account(&self, user: BitwardenUser, user_row: &SqliteRow) -> anyhow::Result<Arrival> {
        let id = user.id.clone();
        let mut left = LeftBehind::new();
        let (sign_in, other_methods) =
            sign_in::read(&self.pool, &self.schema, user_row, &id).await?;
        leave(&mut left, "two-step login methods", other_methods);
        let folders = self.folders(&user, &mut left).await?;
        let in_folder: HashMap<String, String> = self
            .pairs(
                "folders_ciphers",
                "SELECT fc.cipher_uuid, fc.folder_uuid FROM folders_ciphers fc \
                 JOIN folders f ON f.uuid = fc.folder_uuid WHERE f.user_uuid = ?",
                &id,
            )
            .await?
            .into_iter()
            .collect();
        let favorites: HashSet<String> = self
            .pairs(
                "favorites",
                "SELECT cipher_uuid, user_uuid FROM favorites WHERE user_uuid = ?",
                &id,
            )
            .await?
            .into_iter()
            .map(|(cipher, _)| cipher)
            .collect();

        let sql = format!(
            "SELECT {} FROM ciphers WHERE user_uuid = ? AND {}",
            self.schema.select("ciphers", CIPHER_COLUMNS),
            if self.schema.columns["ciphers"].contains("organization_uuid") {
                "organization_uuid IS NULL"
            } else {
                "1 = 1"
            }
        );
        let mut ciphers = Vec::new();
        for row in sqlx::query(&sql).bind(&id).fetch_all(&self.pool).await? {
            let Some(cipher_id) = text(&row, "uuid") else {
                leave(&mut left, "unreadable items", 1);
                continue;
            };
            let created = timestamp(text(&row, "created_at")).unwrap_or(user.created_at);
            let dates = CipherDates {
                created,
                revised: timestamp(text(&row, "updated_at")).unwrap_or(created),
                deleted: timestamp(text(&row, "deleted_at")),
                archived: None,
            };
            let request = cipher_request(
                &row,
                in_folder.get(&cipher_id),
                favorites.contains(&cipher_id),
            );
            match request.and_then(|request| cipher(&id, &cipher_id, request, dates)) {
                Some(cipher) => ciphers.push(cipher),
                None => leave(&mut left, "unreadable items", 1),
            }
        }
        let known: HashSet<String> = ciphers.iter().map(|c| c.id.clone()).collect();
        let attachments = files::attachments(
            &self.pool,
            &self.schema,
            &self.data,
            files::Owner::Account(&id),
            &known,
            &mut left,
        )
        .await?;
        let sends = files::sends(&self.pool, &self.schema, &self.data, &id, &mut left).await?;
        let mut account = BitwardenArrival {
            user,
            folders,
            ciphers,
            sign_in,
        };
        keep_known_folders(&mut account);
        Ok(Arrival {
            account,
            left_behind: left,
            attachments,
            sends,
        })
    }
}

/// Read every account a vaultwarden database holds.
///
/// # Errors
///
/// Returns an error when the file cannot be opened read-only or is not a
/// vaultwarden database.
pub async fn read(path: &Path) -> anyhow::Result<Source> {
    read_with(path, None).await
}

/// As [`read`], with vaultwarden's data folder named when it is not the
/// database's own folder (`DATA_FOLDER` differs from where `db.sqlite3` is).
///
/// # Errors
///
/// As [`read`].
pub async fn read_with(path: &Path, data: Option<&Path>) -> anyhow::Result<Source> {
    let data = data
        .map(Path::to_path_buf)
        .or_else(|| path.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .with_context(|| format!("open {} read-only", path.display()))?;
    let schema = Schema::read(&pool).await?;
    let sql = format!(
        "SELECT {} FROM users ORDER BY email",
        schema.select("users", USER_COLUMNS)
    );
    let rows = sqlx::query(&sql).fetch_all(&pool).await?;
    let reader = Reader { pool, schema, data };
    let mut source = Source::default();
    for row in &rows {
        match user_from(row) {
            Ok(user) => source.arrivals.push(reader.account(user, row).await?),
            Err(skipped) => source.skipped.push(skipped),
        }
    }
    source.organizations = reader.organizations().await?;
    source.emergency = reader.emergency().await?;
    for (kind, table, sql) in [(
        "organization groups",
        "groups",
        "SELECT COUNT(*) FROM groups",
    )] {
        let n = reader.schema.count(&reader.pool, table, sql, None).await;
        leave(&mut source.left_behind, kind, n);
    }
    reader.pool.close().await;
    Ok(source)
}
