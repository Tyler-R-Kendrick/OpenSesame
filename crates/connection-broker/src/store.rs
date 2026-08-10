//! sqlx persistence for the five connection tables.
//!
//! Everything here is row plumbing except `consume_authorization`, which enforces
//! the single-use, TTL-bound `state` the whole flow rests on.

use chrono::{DateTime, Utc};
use opensesame_domain::EgressBinding;
use sqlx::{Row, SqlitePool};

use crate::crypto::SealedBlob;
use crate::error::{BrokerError, Result};
use crate::model::{BindingTargetKind, BindingView, ConnectionStatus, EventKind, EventView};

#[derive(Clone, Debug)]
pub struct ConnectionRow {
    pub id: String,
    pub organization_id: String,
    pub project_id: Option<String>,
    pub provider_id: String,
    pub logical_name: String,
    pub display_name: String,
    pub status: ConnectionStatus,
    pub status_detail: Option<String>,
    pub requested_scopes: Vec<String>,
    pub granted_scopes: Vec<String>,
    pub account_label: Option<String>,
    pub owner_kind: String,
    /// The session subject or principal a connection was created for, when it was
    /// created for one. Null means nobody but an operator may reach it.
    pub owner_subject: Option<String>,
    pub shareability: String,
    pub max_invoke_level: u8,
    pub egress: EgressBinding,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct CredentialRow {
    pub connection_id: String,
    pub sealed: SealedBlob,
    pub token_type: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub refreshable: bool,
    pub last_refreshed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
pub struct AuthorizationRow {
    pub state: String,
    pub connection_id: String,
    pub code_verifier: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub expires_at: DateTime<Utc>,
}

fn parse_time(raw: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(raw)
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(|_| DateTime::<Utc>::MIN_UTC)
}

fn parse_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn connection_from_row(row: &sqlx::sqlite::SqliteRow) -> ConnectionRow {
    ConnectionRow {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        project_id: row.get("project_id"),
        provider_id: row.get("provider_id"),
        logical_name: row.get("logical_name"),
        display_name: row.get("display_name"),
        status: ConnectionStatus::parse(&row.get::<String, _>("status")),
        status_detail: row.get("status_detail"),
        requested_scopes: parse_list(&row.get::<String, _>("requested_scopes")),
        granted_scopes: parse_list(&row.get::<String, _>("granted_scopes")),
        account_label: row.get("account_label"),
        owner_kind: row.get("owner_kind"),
        owner_subject: row.get("owner_subject"),
        shareability: row.get("shareability"),
        max_invoke_level: row.get::<i64, _>("max_invoke_level").clamp(1, 3) as u8,
        egress: serde_json::from_str(&row.get::<String, _>("egress_json"))
            .unwrap_or_else(|_| EgressBinding::default()),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

const CONNECTION_COLUMNS: &str = "id, organization_id, project_id, provider_id, logical_name, \
     display_name, status, status_detail, requested_scopes, granted_scopes, account_label, \
     owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, \
     updated_at";

pub async fn insert_connection(pool: &SqlitePool, c: &ConnectionRow) -> Result<()> {
    sqlx::query(
        "INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, \
         display_name, status, status_detail, requested_scopes, granted_scopes, account_label, \
         owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, \
         updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&c.id)
    .bind(&c.organization_id)
    .bind(&c.project_id)
    .bind(&c.provider_id)
    .bind(&c.logical_name)
    .bind(&c.display_name)
    .bind(c.status.as_str())
    .bind(&c.status_detail)
    .bind(serde_json::to_string(&c.requested_scopes)?)
    .bind(serde_json::to_string(&c.granted_scopes)?)
    .bind(&c.account_label)
    .bind(&c.owner_kind)
    .bind(&c.owner_subject)
    .bind(&c.shareability)
    .bind(c.max_invoke_level as i64)
    .bind(serde_json::to_string(&c.egress)?)
    .bind(c.created_at.to_rfc3339())
    .bind(c.updated_at.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_connection(pool: &SqlitePool, id: &str) -> Result<Option<ConnectionRow>> {
    let row = sqlx::query(&format!(
        "SELECT {CONNECTION_COLUMNS} FROM connections WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(connection_from_row))
}

pub async fn list_connections(
    pool: &SqlitePool,
    organization_id: &str,
) -> Result<Vec<ConnectionRow>> {
    let rows = sqlx::query(&format!(
        "SELECT {CONNECTION_COLUMNS} FROM connections WHERE organization_id = ? ORDER BY created_at ASC"
    ))
    .bind(organization_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(connection_from_row).collect())
}

pub async fn logical_name_taken(
    pool: &SqlitePool,
    organization_id: &str,
    logical_name: &str,
) -> Result<bool> {
    let row = sqlx::query(
        "SELECT 1 AS present FROM connections WHERE organization_id = ? AND logical_name = ?",
    )
    .bind(organization_id)
    .bind(logical_name)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn set_status(
    pool: &SqlitePool,
    id: &str,
    status: ConnectionStatus,
    detail: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "UPDATE connections SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?",
    )
    .bind(status.as_str())
    .bind(detail)
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_grant_details(
    pool: &SqlitePool,
    id: &str,
    granted_scopes: &[String],
    account_label: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "UPDATE connections SET granted_scopes = ?, account_label = COALESCE(?, account_label), updated_at = ? WHERE id = ?",
    )
    .bind(serde_json::to_string(granted_scopes)?)
    .bind(account_label)
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_requested_scopes(pool: &SqlitePool, id: &str, scopes: &[String]) -> Result<()> {
    sqlx::query("UPDATE connections SET requested_scopes = ?, updated_at = ? WHERE id = ?")
        .bind(serde_json::to_string(scopes)?)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn upsert_credential(pool: &SqlitePool, c: &CredentialRow) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO connection_credentials (connection_id, ciphertext, nonce, aad_digest, \
         token_type, expires_at, refreshable, last_refreshed_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(connection_id) DO UPDATE SET ciphertext = excluded.ciphertext, \
         nonce = excluded.nonce, aad_digest = excluded.aad_digest, token_type = excluded.token_type, \
         expires_at = excluded.expires_at, refreshable = excluded.refreshable, \
         last_refreshed_at = excluded.last_refreshed_at, updated_at = excluded.updated_at",
    )
    .bind(&c.connection_id)
    .bind(&c.sealed.ciphertext)
    .bind(&c.sealed.nonce)
    .bind(&c.sealed.aad_digest)
    .bind(&c.token_type)
    .bind(c.expires_at.map(|t| t.to_rfc3339()))
    .bind(i64::from(c.refreshable))
    .bind(c.last_refreshed_at.map(|t| t.to_rfc3339()))
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_credential(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Option<CredentialRow>> {
    let row = sqlx::query(
        "SELECT connection_id, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, \
         last_refreshed_at FROM connection_credentials WHERE connection_id = ?",
    )
    .bind(connection_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| CredentialRow {
        connection_id: r.get("connection_id"),
        sealed: SealedBlob {
            ciphertext: r.get("ciphertext"),
            nonce: r.get("nonce"),
            aad_digest: r.get("aad_digest"),
        },
        token_type: r.get("token_type"),
        expires_at: r
            .get::<Option<String>, _>("expires_at")
            .map(|s| parse_time(&s)),
        refreshable: r.get::<i64, _>("refreshable") == 1,
        last_refreshed_at: r
            .get::<Option<String>, _>("last_refreshed_at")
            .map(|s| parse_time(&s)),
    }))
}

pub async fn delete_credential(pool: &SqlitePool, connection_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM connection_credentials WHERE connection_id = ?")
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn insert_authorization(pool: &SqlitePool, a: &AuthorizationRow) -> Result<()> {
    sqlx::query(
        "INSERT INTO connection_authorizations (state, connection_id, code_verifier, redirect_uri, \
         scopes, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(&a.state)
    .bind(&a.connection_id)
    .bind(&a.code_verifier)
    .bind(&a.redirect_uri)
    .bind(serde_json::to_string(&a.scopes)?)
    .bind(Utc::now().to_rfc3339())
    .bind(a.expires_at.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

/// Claims a `state` exactly once. The verifier is erased in the same statement
/// that marks consumption, so a replay finds nothing to exchange with — and a
/// concurrent replay loses the race rather than getting a second copy.
pub async fn consume_authorization(
    pool: &SqlitePool,
    state: &str,
    now: DateTime<Utc>,
) -> Result<AuthorizationRow> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        "SELECT state, connection_id, code_verifier, redirect_uri, scopes, expires_at, consumed_at \
         FROM connection_authorizations WHERE state = ?",
    )
    .bind(state)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(BrokerError::InvalidState)?;

    if row.get::<Option<String>, _>("consumed_at").is_some() {
        return Err(BrokerError::InvalidState);
    }
    let expires_at = parse_time(&row.get::<String, _>("expires_at"));
    if now >= expires_at {
        // Expiry is terminal for this state; clear the verifier rather than leave
        // it sitting in the table until something else prunes it.
        sqlx::query(
            "UPDATE connection_authorizations SET code_verifier = '', consumed_at = ? WHERE state = ?",
        )
        .bind(now.to_rfc3339())
        .bind(state)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(BrokerError::StateExpired);
    }

    let claimed = sqlx::query(
        "UPDATE connection_authorizations SET code_verifier = '', consumed_at = ? \
         WHERE state = ? AND consumed_at IS NULL",
    )
    .bind(now.to_rfc3339())
    .bind(state)
    .execute(&mut *tx)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(BrokerError::InvalidState);
    }

    let authorization = AuthorizationRow {
        state: row.get("state"),
        connection_id: row.get("connection_id"),
        code_verifier: row.get("code_verifier"),
        redirect_uri: row.get("redirect_uri"),
        scopes: parse_list(&row.get::<String, _>("scopes")),
        expires_at,
    };
    tx.commit().await?;
    Ok(authorization)
}

pub async fn insert_binding(
    pool: &SqlitePool,
    connection_id: &str,
    kind: BindingTargetKind,
    target_id: &str,
    target_label: Option<&str>,
) -> Result<()> {
    let existing = sqlx::query(
        "SELECT 1 AS present FROM connection_bindings WHERE connection_id = ? AND target_kind = ? AND target_id = ?",
    )
    .bind(connection_id)
    .bind(kind.as_str())
    .bind(target_id)
    .fetch_optional(pool)
    .await?;
    if existing.is_some() {
        return Err(BrokerError::BindingExists);
    }
    sqlx::query(
        "INSERT INTO connection_bindings (id, connection_id, target_kind, target_id, target_label, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(connection_id)
    .bind(kind.as_str())
    .bind(target_id)
    .bind(target_label)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_binding(
    pool: &SqlitePool,
    connection_id: &str,
    binding_id: &str,
) -> Result<()> {
    let deleted = sqlx::query("DELETE FROM connection_bindings WHERE id = ? AND connection_id = ?")
        .bind(binding_id)
        .bind(connection_id)
        .execute(pool)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(BrokerError::BindingNotFound);
    }
    Ok(())
}

pub async fn list_bindings(pool: &SqlitePool, connection_id: &str) -> Result<Vec<BindingView>> {
    let rows = sqlx::query(
        "SELECT id, target_kind, target_id, target_label, created_at FROM connection_bindings \
         WHERE connection_id = ? ORDER BY created_at ASC",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| BindingView {
            id: r.get("id"),
            target_kind: BindingTargetKind::parse(&r.get::<String, _>("target_kind"))
                .unwrap_or(BindingTargetKind::Organization),
            target_id: r.get("target_id"),
            target_label: r.get("target_label"),
            created_at: r.get("created_at"),
        })
        .collect())
}

pub async fn append_event(
    pool: &SqlitePool,
    connection_id: &str,
    kind: EventKind,
    detail: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO connection_events (id, connection_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(connection_id)
    .bind(kind.as_str())
    .bind(detail)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_events(pool: &SqlitePool, connection_id: &str) -> Result<Vec<EventView>> {
    let rows = sqlx::query(
        "SELECT id, kind, detail, at FROM connection_events WHERE connection_id = ? ORDER BY at ASC, id ASC",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| EventView {
            id: r.get("id"),
            kind: r.get("kind"),
            detail: r.get("detail"),
            at: r.get("at"),
        })
        .collect())
}
