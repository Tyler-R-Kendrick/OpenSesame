//! sqlx persistence for the five connection tables.
//!
//! Everything here is row plumbing except `consume_authorization`, which enforces
//! the single-use, TTL-bound `state` the whole flow rests on.

use chrono::{DateTime, Utc};
use opensesame_domain::EgressBinding;
use sha2::{Digest, Sha256};
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
    pub integration_id: String,
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
    /// ADR 0049: `deny` (default) or `derived_short_lived`.
    pub materialization: String,
    pub egress: EgressBinding,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct CredentialRow {
    pub connection_id: String,
    pub version: String,
    pub sealed: SealedBlob,
    pub token_type: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub refreshable: bool,
    pub last_refreshed_at: Option<DateTime<Utc>>,
    pub configured_field_names: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct AuthorizationRow {
    pub state: String,
    pub connection_id: String,
    pub code_verifier: SealedBlob,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub expires_at: DateTime<Utc>,
    /// Credential generation observed when this authorization state was issued.
    /// Null means the connection had no credential and activation must still find none.
    pub credential_version: Option<String>,
}

fn state_digest(state: &str) -> String {
    Sha256::digest(state.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
        integration_id: row
            .get::<Option<String>, _>("integration_id")
            .unwrap_or_default(),
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
        materialization: row.get("materialization"),
        egress: serde_json::from_str(&row.get::<String, _>("egress_json"))
            .unwrap_or_else(|_| EgressBinding::default()),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

const CONNECTION_COLUMNS: &str =
    "id, organization_id, project_id, provider_id, integration_id, logical_name, \
     display_name, status, status_detail, requested_scopes, granted_scopes, account_label, \
     owner_kind, owner_subject, shareability, max_invoke_level, materialization, egress_json, \
     created_at, updated_at";

pub async fn insert_connection(pool: &SqlitePool, c: &ConnectionRow) -> Result<()> {
    sqlx::query(
        "INSERT INTO connections (id, organization_id, project_id, provider_id, integration_id, logical_name, \
         display_name, status, status_detail, requested_scopes, granted_scopes, account_label, \
         owner_kind, owner_subject, shareability, max_invoke_level, materialization, egress_json, \
         created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&c.id)
    .bind(&c.organization_id)
    .bind(&c.project_id)
    .bind(&c.provider_id)
    .bind(&c.integration_id)
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
    .bind(&c.materialization)
    .bind(serde_json::to_string(&c.egress)?)
    .bind(c.created_at.to_rfc3339())
    .bind(c.updated_at.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_connection(pool: &SqlitePool, id: &str) -> Result<Option<ConnectionRow>> {
    // CONNECTION_COLUMNS is a compile-time constant; only `id` is data and it is bound.
    // ast-grep-ignore: sql-format-injection
    let row = sqlx::query(&format!(
        "SELECT {CONNECTION_COLUMNS} FROM connections WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(connection_from_row))
}

pub async fn delete_connection(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM connections WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_connections(
    pool: &SqlitePool,
    organization_id: &str,
) -> Result<Vec<ConnectionRow>> {
    // CONNECTION_COLUMNS is a compile-time constant; organization_id is bound.
    // ast-grep-ignore: sql-format-injection
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

pub async fn transition_unless_revoked(
    pool: &SqlitePool,
    id: &str,
    status: ConnectionStatus,
    detail: Option<&str>,
    event_kind: EventKind,
    event_detail: Option<&str>,
) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    let mut transaction = pool.begin().await?;
    let changed = sqlx::query("UPDATE connections SET status = ?, status_detail = ?, updated_at = ? WHERE id = ? AND status != 'revoked'")
        .bind(status.as_str())
        .bind(detail)
        .bind(&now)
        .bind(id)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
        == 1;
    if changed {
        sqlx::query("INSERT INTO connection_events (id, connection_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)")
            .bind(uuid::Uuid::now_v7().to_string())
            .bind(id)
            .bind(event_kind.as_str())
            .bind(event_detail)
            .bind(&now)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
    } else {
        transaction.rollback().await?;
    }
    Ok(changed)
}

/// Records a failed post-response transition and removes any superseded local
/// credential in the same transaction. A concurrent terminal revoke wins.
pub async fn invalidate_credential_unless_revoked(
    pool: &SqlitePool,
    id: &str,
    status: ConnectionStatus,
    detail: &str,
    event_kind: EventKind,
) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    let mut transaction = pool.begin().await?;
    let changed = sqlx::query("UPDATE connections SET status = ?, status_detail = ?, updated_at = ? WHERE id = ? AND status != 'revoked'")
        .bind(status.as_str())
        .bind(detail)
        .bind(&now)
        .bind(id)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
        == 1;
    if !changed {
        transaction.rollback().await?;
        return Ok(false);
    }
    sqlx::query("DELETE FROM connection_credentials WHERE connection_id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    append_backup_outbox(
        &mut transaction,
        "connection.credential.invalidated",
        id,
        detail,
    )
    .await?;
    sqlx::query("INSERT INTO connection_events (id, connection_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)")
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(id)
        .bind(event_kind.as_str())
        .bind(detail)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(true)
}

pub async fn revoke_local(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    sqlx::query("UPDATE connections SET status = 'revoked', status_detail = NULL, updated_at = ? WHERE id = ?")
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM connection_authorizations WHERE connection_id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM connection_credentials WHERE connection_id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    append_backup_outbox(
        &mut transaction,
        "connection.credential.revoked",
        id,
        "revoked",
    )
    .await?;
    transaction.commit().await?;
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

pub async fn set_integration_id(pool: &SqlitePool, id: &str, integration_id: &str) -> Result<()> {
    sqlx::query("UPDATE connections SET integration_id = ?, updated_at = ? WHERE id = ?")
        .bind(integration_id)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_policy(
    pool: &SqlitePool,
    connection_id: &str,
    organization_id: &str,
    shareability: &str,
    max_invoke_level: u8,
    materialization: &str,
) -> Result<()> {
    let changed = sqlx::query(
        "UPDATE connections SET shareability = ?, max_invoke_level = ?, materialization = ?, \
         updated_at = ? \
         WHERE id = ? AND organization_id = ? AND status != 'revoked'",
    )
    .bind(shareability)
    .bind(max_invoke_level as i64)
    .bind(materialization)
    .bind(Utc::now().to_rfc3339())
    .bind(connection_id)
    .bind(organization_id)
    .execute(pool)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(BrokerError::ConnectionNotFound);
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub struct CredentialActivation<'a> {
    pub credential: &'a CredentialRow,
    pub organization_id: &'a str,
    pub integration_id: &'a str,
    pub expected_integration_updated_at: Option<&'a str>,
    pub requested_scopes: &'a [String],
    pub granted_scopes: &'a [String],
    pub account_label: Option<&'a str>,
    pub event_kind: EventKind,
    pub event_detail: Option<&'a str>,
    pub expected_credential_version: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialActivationOutcome {
    Activated,
    Revoked,
    Superseded,
}

pub async fn activate_credential_unless_revoked(
    pool: &SqlitePool,
    activation: CredentialActivation<'_>,
) -> Result<CredentialActivationOutcome> {
    let c = activation.credential;
    let now = Utc::now().to_rfc3339();
    let mut transaction = pool.begin().await?;
    let writer_lock = sqlx::query("UPDATE connections SET updated_at = updated_at WHERE id = ?")
        .bind(&c.connection_id)
        .execute(&mut *transaction)
        .await;
    if let Err(error) = writer_lock {
        transaction.rollback().await?;
        return Err(error.into());
    }
    let status = sqlx::query("SELECT status FROM connections WHERE id = ?")
        .bind(&c.connection_id)
        .fetch_one(&mut *transaction)
        .await?
        .get::<String, _>("status");
    if status == "revoked" {
        transaction.rollback().await?;
        return Ok(CredentialActivationOutcome::Revoked);
    }
    let current_version =
        sqlx::query("SELECT version FROM connection_credentials WHERE connection_id = ?")
            .bind(&c.connection_id)
            .fetch_optional(&mut *transaction)
            .await?
            .map(|row| row.get::<String, _>("version"));
    if current_version.as_deref() != activation.expected_credential_version {
        transaction.rollback().await?;
        return Ok(CredentialActivationOutcome::Superseded);
    }
    if !activation.integration_id.starts_with("deployment:") {
        let integration = sqlx::query(
            "SELECT enabled, scopes, updated_at FROM integrations WHERE id = ? AND organization_id = ?",
        )
        .bind(activation.integration_id)
        .bind(activation.organization_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(BrokerError::IntegrationNotFound)?;
        if integration.get::<i64, _>("enabled") == 0 {
            return Err(BrokerError::IntegrationNotFound);
        }
        if activation
            .expected_integration_updated_at
            .is_some_and(|expected| integration.get::<String, _>("updated_at") != expected)
        {
            return Err(BrokerError::IntegrationConflict);
        }
        let ceiling = parse_list(&integration.get::<String, _>("scopes"));
        if let Some(scope) = activation
            .requested_scopes
            .iter()
            .chain(activation.granted_scopes)
            .find(|scope| !ceiling.contains(scope))
        {
            return Err(BrokerError::Invalid(format!(
                "scope `{scope}` exceeds the integration scope ceiling"
            )));
        }
    }
    sqlx::query(
        "INSERT INTO connection_credentials (connection_id, version, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, last_refreshed_at, configured_fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET version = excluded.version, ciphertext = excluded.ciphertext, nonce = excluded.nonce, aad_digest = excluded.aad_digest, token_type = excluded.token_type, expires_at = excluded.expires_at, refreshable = excluded.refreshable, last_refreshed_at = excluded.last_refreshed_at, configured_fields = excluded.configured_fields, updated_at = excluded.updated_at",
    )
    .bind(&c.connection_id)
    .bind(&c.version)
    .bind(&c.sealed.ciphertext)
    .bind(&c.sealed.nonce)
    .bind(&c.sealed.aad_digest)
    .bind(&c.token_type)
    .bind(c.expires_at.map(|time| time.to_rfc3339()))
    .bind(i64::from(c.refreshable))
    .bind(c.last_refreshed_at.map(|time| time.to_rfc3339()))
    .bind(serde_json::to_string(&c.configured_field_names)?)
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await?;
    sqlx::query("UPDATE connections SET status = 'active', status_detail = NULL, granted_scopes = ?, account_label = COALESCE(?, account_label), updated_at = ? WHERE id = ?")
        .bind(serde_json::to_string(activation.granted_scopes)?)
        .bind(activation.account_label)
        .bind(&now)
        .bind(&c.connection_id)
        .execute(&mut *transaction)
        .await?
        ;
    sqlx::query("INSERT INTO connection_events (id, connection_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)")
            .bind(uuid::Uuid::now_v7().to_string())
            .bind(&c.connection_id)
            .bind(activation.event_kind.as_str())
            .bind(activation.event_detail)
            .bind(&now)
        .execute(&mut *transaction)
        .await?;
    append_backup_outbox(
        &mut transaction,
        "connection.credential.stored",
        &c.connection_id,
        activation.event_kind.as_str(),
    )
    .await?;
    transaction.commit().await?;
    Ok(CredentialActivationOutcome::Activated)
}

/// Broadcast a secret-change event in the same transaction as the mutation it
/// describes (transactional outbox, ADR 0039). The backup actor drains these;
/// payloads carry references only, never material.
async fn append_backup_outbox(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event_type: &str,
    connection_id: &str,
    detail: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO outbox_events (id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(event_type)
    .bind(serde_json::json!({"connection_id": connection_id, "detail": detail}).to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Every sealed credential row, for backup snapshots. Ciphertext only — the
/// deployment key that opens these never travels with them (ADR 0039).
pub async fn list_sealed_credentials(pool: &SqlitePool) -> Result<Vec<CredentialRow>> {
    let rows = sqlx::query(
        "SELECT connection_id, version, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, last_refreshed_at, configured_fields \
         FROM connection_credentials ORDER BY connection_id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| CredentialRow {
            connection_id: r.get("connection_id"),
            version: r.get("version"),
            sealed: SealedBlob {
                ciphertext: r.get("ciphertext"),
                nonce: r.get("nonce"),
                aad_digest: r.get("aad_digest"),
            },
            token_type: r.get("token_type"),
            expires_at: r
                .get::<Option<String>, _>("expires_at")
                .map(|s| parse_time(&s)),
            refreshable: r.get::<i64, _>("refreshable") != 0,
            last_refreshed_at: r
                .get::<Option<String>, _>("last_refreshed_at")
                .map(|s| parse_time(&s)),
            configured_field_names: parse_list(&r.get::<String, _>("configured_fields")),
        })
        .collect())
}

pub async fn get_credential(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Option<CredentialRow>> {
    let row = sqlx::query(
        "SELECT connection_id, version, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, \
         last_refreshed_at, configured_fields FROM connection_credentials WHERE connection_id = ?",
    )
    .bind(connection_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| CredentialRow {
        connection_id: r.get("connection_id"),
        version: r.get("version"),
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
        configured_field_names: parse_list(&r.get::<String, _>("configured_fields")),
    }))
}

pub async fn clear_credential_unless_revoked(
    pool: &SqlitePool,
    connection_id: &str,
    expected_version: Option<&str>,
) -> Result<CredentialActivationOutcome> {
    let mut transaction = pool.begin().await?;
    sqlx::query("UPDATE connections SET updated_at = updated_at WHERE id = ?")
        .bind(connection_id)
        .execute(&mut *transaction)
        .await?;
    let status = sqlx::query("SELECT status FROM connections WHERE id = ?")
        .bind(connection_id)
        .fetch_one(&mut *transaction)
        .await?
        .get::<String, _>("status");
    if status == "revoked" {
        transaction.rollback().await?;
        return Ok(CredentialActivationOutcome::Revoked);
    }
    let current_version =
        sqlx::query("SELECT version FROM connection_credentials WHERE connection_id = ?")
            .bind(connection_id)
            .fetch_optional(&mut *transaction)
            .await?
            .map(|row| row.get::<String, _>("version"));
    if current_version.as_deref() != expected_version {
        transaction.rollback().await?;
        return Ok(CredentialActivationOutcome::Superseded);
    }
    sqlx::query("DELETE FROM connection_credentials WHERE connection_id = ?")
        .bind(connection_id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("UPDATE connections SET status = 'pending', status_detail = NULL, granted_scopes = '[]', updated_at = ? WHERE id = ?")
        .bind(Utc::now().to_rfc3339())
        .bind(connection_id)
        .execute(&mut *transaction)
        .await?;
    append_backup_outbox(
        &mut transaction,
        "connection.credential.cleared",
        connection_id,
        "cleared",
    )
    .await?;
    transaction.commit().await?;
    Ok(CredentialActivationOutcome::Activated)
}

pub async fn delete_credential(pool: &SqlitePool, connection_id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    sqlx::query("DELETE FROM connection_credentials WHERE connection_id = ?")
        .bind(connection_id)
        .execute(&mut *transaction)
        .await?;
    append_backup_outbox(
        &mut transaction,
        "connection.credential.deleted",
        connection_id,
        "deleted",
    )
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub async fn insert_authorization(pool: &SqlitePool, a: &AuthorizationRow) -> Result<()> {
    sqlx::query(
        "INSERT INTO connection_authorizations (state, connection_id, code_verifier, verifier_nonce, verifier_aad_digest, redirect_uri, scopes, created_at, expires_at, consumed_at, credential_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(state_digest(&a.state))
    .bind(&a.connection_id)
    .bind(&a.code_verifier.ciphertext)
    .bind(&a.code_verifier.nonce)
    .bind(&a.code_verifier.aad_digest)
    .bind(&a.redirect_uri)
    .bind(serde_json::to_string(&a.scopes)?)
    .bind(Utc::now().to_rfc3339())
    .bind(a.expires_at.to_rfc3339())
    .bind(&a.credential_version)
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
        "SELECT state, connection_id, code_verifier, verifier_nonce, verifier_aad_digest, redirect_uri, scopes, expires_at, consumed_at, credential_version \
         FROM connection_authorizations WHERE state = ?",
    )
    .bind(state_digest(state))
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
            "UPDATE connection_authorizations SET code_verifier = X'', verifier_nonce = NULL, verifier_aad_digest = NULL, consumed_at = ? WHERE state = ?",
        )
        .bind(now.to_rfc3339())
        .bind(state_digest(state))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(BrokerError::StateExpired);
    }

    let claimed = sqlx::query(
        "UPDATE connection_authorizations SET code_verifier = X'', verifier_nonce = NULL, verifier_aad_digest = NULL, consumed_at = ? \
         WHERE state = ? AND consumed_at IS NULL",
    )
    .bind(now.to_rfc3339())
    .bind(state_digest(state))
    .execute(&mut *tx)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(BrokerError::InvalidState);
    }

    let authorization = AuthorizationRow {
        state: row.get("state"),
        connection_id: row.get("connection_id"),
        code_verifier: SealedBlob {
            ciphertext: row.get("code_verifier"),
            nonce: row
                .get::<Option<Vec<u8>>, _>("verifier_nonce")
                .unwrap_or_default(),
            aad_digest: row
                .get::<Option<String>, _>("verifier_aad_digest")
                .unwrap_or_default(),
        },
        redirect_uri: row.get("redirect_uri"),
        scopes: parse_list(&row.get::<String, _>("scopes")),
        expires_at,
        credential_version: row.get("credential_version"),
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

// ---- sync_targets -----------------------------------------------------------

#[derive(Clone, Debug)]
pub struct SyncTargetRow {
    pub id: String,
    pub organization_id: String,
    pub project_id: String,
    pub config_id: String,
    pub connection_id: String,
    pub provider_id: String,
    pub operation: String,
    pub status: String,
    pub status_detail: Option<String>,
    pub content_version: Option<String>,
    pub last_synced_at: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn sync_target_from_row(row: &sqlx::sqlite::SqliteRow) -> SyncTargetRow {
    SyncTargetRow {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        project_id: row.get("project_id"),
        config_id: row.get("config_id"),
        connection_id: row.get("connection_id"),
        provider_id: row.get("provider_id"),
        operation: row.get("operation"),
        status: row.get("status"),
        status_detail: row.get("status_detail"),
        content_version: row.get("content_version"),
        last_synced_at: row.get("last_synced_at"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

const SYNC_TARGET_COLUMNS: &str =
    "id, organization_id, project_id, config_id, connection_id, provider_id, operation, \
     status, status_detail, content_version, last_synced_at, created_at, updated_at";

/// Idempotent DDL for sync targets. Lives here so WP-C does not own root
/// `migrations/` / `crates/storage` registration (orchestrator may promote later).
pub async fn ensure_sync_targets_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_targets (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            config_id TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            status TEXT NOT NULL,
            status_detail TEXT,
            content_version TEXT,
            last_synced_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
         )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sync_targets_org_config \
         ON sync_targets(organization_id, config_id)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sync_targets_org_project \
         ON sync_targets(organization_id, project_id)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn insert_sync_target(pool: &SqlitePool, row: &SyncTargetRow) -> Result<()> {
    ensure_sync_targets_schema(pool).await?;
    sqlx::query(
        "INSERT INTO sync_targets (id, organization_id, project_id, config_id, connection_id, \
         provider_id, operation, status, status_detail, content_version, last_synced_at, \
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.organization_id)
    .bind(&row.project_id)
    .bind(&row.config_id)
    .bind(&row.connection_id)
    .bind(&row.provider_id)
    .bind(&row.operation)
    .bind(&row.status)
    .bind(&row.status_detail)
    .bind(&row.content_version)
    .bind(&row.last_synced_at)
    .bind(row.created_at.to_rfc3339())
    .bind(row.updated_at.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_sync_target(pool: &SqlitePool, id: &str) -> Result<Option<SyncTargetRow>> {
    ensure_sync_targets_schema(pool).await?;
    // SYNC_TARGET_COLUMNS is a compile-time constant; only `id` is data and it is bound.
    // ast-grep-ignore: sql-format-injection
    let row = sqlx::query(&format!(
        "SELECT {SYNC_TARGET_COLUMNS} FROM sync_targets WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(sync_target_from_row))
}

pub async fn list_sync_targets(
    pool: &SqlitePool,
    organization_id: &str,
    project_id: Option<&str>,
    config_id: Option<&str>,
) -> Result<Vec<SyncTargetRow>> {
    ensure_sync_targets_schema(pool).await?;
    let rows = match (project_id, config_id) {
        (Some(project), Some(config)) => {
            // SYNC_TARGET_COLUMNS is constant; all data values are bound below.
            // ast-grep-ignore: sql-format-injection
            sqlx::query(&format!(
                "SELECT {SYNC_TARGET_COLUMNS} FROM sync_targets \
                 WHERE organization_id = ? AND project_id = ? AND config_id = ? \
                 ORDER BY created_at ASC"
            ))
            .bind(organization_id)
            .bind(project)
            .bind(config)
            .fetch_all(pool)
            .await?
        }
        (Some(project), None) => {
            // SYNC_TARGET_COLUMNS is constant; all data values are bound below.
            // ast-grep-ignore: sql-format-injection
            sqlx::query(&format!(
                "SELECT {SYNC_TARGET_COLUMNS} FROM sync_targets \
                 WHERE organization_id = ? AND project_id = ? ORDER BY created_at ASC"
            ))
            .bind(organization_id)
            .bind(project)
            .fetch_all(pool)
            .await?
        }
        (None, Some(config)) => {
            // SYNC_TARGET_COLUMNS is constant; all data values are bound below.
            // ast-grep-ignore: sql-format-injection
            sqlx::query(&format!(
                "SELECT {SYNC_TARGET_COLUMNS} FROM sync_targets \
                 WHERE organization_id = ? AND config_id = ? ORDER BY created_at ASC"
            ))
            .bind(organization_id)
            .bind(config)
            .fetch_all(pool)
            .await?
        }
        (None, None) => {
            // SYNC_TARGET_COLUMNS is constant; all data values are bound below.
            // ast-grep-ignore: sql-format-injection
            sqlx::query(&format!(
                "SELECT {SYNC_TARGET_COLUMNS} FROM sync_targets \
                 WHERE organization_id = ? ORDER BY created_at ASC"
            ))
            .bind(organization_id)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows.iter().map(sync_target_from_row).collect())
}

pub async fn delete_sync_target(
    pool: &SqlitePool,
    organization_id: &str,
    id: &str,
) -> Result<bool> {
    ensure_sync_targets_schema(pool).await?;
    let deleted = sqlx::query("DELETE FROM sync_targets WHERE id = ? AND organization_id = ?")
        .bind(id)
        .bind(organization_id)
        .execute(pool)
        .await?;
    Ok(deleted.rows_affected() > 0)
}

pub async fn update_sync_target_status(
    pool: &SqlitePool,
    id: &str,
    status: &str,
    status_detail: Option<&str>,
    content_version: Option<&str>,
    last_synced_at: Option<&str>,
) -> Result<()> {
    ensure_sync_targets_schema(pool).await?;
    sqlx::query(
        "UPDATE sync_targets SET status = ?, status_detail = ?, content_version = COALESCE(?, content_version), \
         last_synced_at = COALESCE(?, last_synced_at), updated_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(status_detail)
    .bind(content_version)
    .bind(last_synced_at)
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

// ---- project-config secret store (ADR 0052) --------------------------------
//
// Values are sealed with the broker deployment key under the §4.2 AAD
// (org|project|config|key|version) before they touch a row. Reads on the API
// surface return names + version metadata only; `load_config_values_sealed`
// hands ciphertext rows to in-process consumers (sync, rotation, operator
// materialize), which open them with `crypto::open_with_ad` and never persist
// plaintext.
//
// DDL lives here as idempotent `ensure_*` schema, following the sync_targets
// precedent above, so this module does not own root `migrations/` numbering.

#[derive(Clone, Debug)]
pub struct SecretConfigRow {
    pub id: String,
    pub organization_id: String,
    pub project_id: String,
    pub slug: String,
    pub display_name: String,
    pub environment: String,
    pub parent_config_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct ConfigKeyMetaRow {
    pub key_name: String,
    pub version: i64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct ConfigValueRow {
    pub key_name: String,
    pub version: i64,
    pub sealed: SealedBlob,
}

#[derive(Clone, Debug)]
pub struct ConfigValueVersionMetaRow {
    pub version: i64,
    pub deleted: bool,
    pub actor_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// One dirty-config wake event for the sync actor. Kept in a dedicated table
/// because the shared `outbox_events` table is drained wholesale by the backup
/// actor (`claim_outbox_batch` has no event-type filter); sharing it would let
/// the backup pass consume sync wakes before the sync actor ever saw them.
#[derive(Clone, Debug)]
pub struct ConfigSyncEventRow {
    pub id: String,
    pub event_type: String,
    pub organization_id: String,
    pub project_id: String,
    pub config_id: String,
    pub attempts: i64,
    pub created_at: DateTime<Utc>,
}

pub const CONFIG_ENVIRONMENTS: [&str; 4] = ["development", "staging", "production", "custom"];

pub async fn ensure_secret_configs_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS secret_configs (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            display_name TEXT NOT NULL,
            environment TEXT NOT NULL CHECK (environment IN
                ('development','staging','production','custom')),
            parent_config_id TEXT NULL REFERENCES secret_configs(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (organization_id, project_id, slug)
         )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_secret_configs_org_project \
         ON secret_configs(organization_id, project_id)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS config_secret_values (
            organization_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            config_id TEXT NOT NULL REFERENCES secret_configs(id),
            key_name TEXT NOT NULL,
            ciphertext BLOB NOT NULL,
            nonce BLOB NOT NULL,
            aad_digest TEXT NOT NULL,
            version INTEGER NOT NULL,
            updated_by TEXT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (config_id, key_name)
         )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS config_secret_value_versions (
            config_id TEXT NOT NULL,
            key_name TEXT NOT NULL,
            version INTEGER NOT NULL,
            ciphertext BLOB NOT NULL,
            nonce BLOB NOT NULL,
            aad_digest TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            actor_id TEXT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (config_id, key_name, version)
         )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS config_sync_outbox (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            config_id TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            available_at TEXT NULL,
            published_at TEXT NULL,
            dead_lettered_at TEXT NULL,
            last_error TEXT NULL,
            created_at TEXT NOT NULL
         )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_config_sync_outbox_pending \
         ON config_sync_outbox(published_at, dead_lettered_at, available_at)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn secret_config_from_row(row: &sqlx::sqlite::SqliteRow) -> SecretConfigRow {
    SecretConfigRow {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        project_id: row.get("project_id"),
        slug: row.get("slug"),
        display_name: row.get("display_name"),
        environment: row.get("environment"),
        parent_config_id: row.get("parent_config_id"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

const SECRET_CONFIG_COLUMNS: &str = "id, organization_id, project_id, slug, display_name, \
     environment, parent_config_id, created_at, updated_at";

pub async fn insert_secret_config(pool: &SqlitePool, row: &SecretConfigRow) -> Result<()> {
    ensure_secret_configs_schema(pool).await?;
    if !CONFIG_ENVIRONMENTS.contains(&row.environment.as_str()) {
        return Err(BrokerError::Invalid(format!(
            "environment must be one of {}",
            CONFIG_ENVIRONMENTS.join(", ")
        )));
    }
    sqlx::query(
        "INSERT INTO secret_configs (id, organization_id, project_id, slug, display_name, \
         environment, parent_config_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.organization_id)
    .bind(&row.project_id)
    .bind(&row.slug)
    .bind(&row.display_name)
    .bind(&row.environment)
    .bind(&row.parent_config_id)
    .bind(row.created_at.to_rfc3339())
    .bind(row.updated_at.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_secret_configs(
    pool: &SqlitePool,
    organization_id: &str,
    project_id: &str,
) -> Result<Vec<SecretConfigRow>> {
    ensure_secret_configs_schema(pool).await?;
    let rows = sqlx::query(&format!(
        "SELECT {SECRET_CONFIG_COLUMNS} FROM secret_configs \
         WHERE organization_id = ? AND project_id = ? ORDER BY slug",
    ))
    .bind(organization_id)
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(secret_config_from_row).collect())
}

pub async fn get_secret_config(
    pool: &SqlitePool,
    organization_id: &str,
    config_id: &str,
) -> Result<Option<SecretConfigRow>> {
    ensure_secret_configs_schema(pool).await?;
    let row = sqlx::query(&format!(
        "SELECT {SECRET_CONFIG_COLUMNS} FROM secret_configs \
         WHERE id = ? AND organization_id = ?",
    ))
    .bind(config_id)
    .bind(organization_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(secret_config_from_row))
}

/// Deletes a config and its values/versions in one transaction. The caller
/// (domain layer) is responsible for refusing while sync targets reference it.
pub async fn delete_secret_config(
    pool: &SqlitePool,
    organization_id: &str,
    config_id: &str,
) -> Result<bool> {
    ensure_secret_configs_schema(pool).await?;
    let mut tx = pool.begin().await?;
    let deleted = sqlx::query("DELETE FROM secret_configs WHERE id = ? AND organization_id = ?")
        .bind(config_id)
        .bind(organization_id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() == 0 {
        return Ok(false);
    }
    sqlx::query("DELETE FROM config_secret_values WHERE config_id = ?")
        .bind(config_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM config_secret_value_versions WHERE config_id = ?")
        .bind(config_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

pub struct UpsertConfigValue<'a> {
    pub organization_id: &'a str,
    pub project_id: &'a str,
    pub config_id: &'a str,
    pub key_name: &'a str,
    pub plaintext: &'a [u8],
    pub actor_id: Option<&'a str>,
}

async fn append_config_sync_outbox(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event_type: &str,
    organization_id: &str,
    project_id: &str,
    config_id: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO config_sync_outbox (id, event_type, organization_id, project_id, \
         config_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(event_type)
    .bind(organization_id)
    .bind(project_id)
    .bind(config_id)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Seals the plaintext under the next version's AAD and, in ONE transaction:
/// upserts the head row, appends an immutable versions row, appends a
/// `sync.config.dirty` wake for the sync actor, and appends a backup outbox
/// event so the backup snapshot stays complete. Returns the new head version.
pub async fn upsert_config_value(
    pool: &SqlitePool,
    key: &[u8; 32],
    p: UpsertConfigValue<'_>,
) -> Result<u64> {
    ensure_secret_configs_schema(pool).await?;
    let config = get_secret_config(pool, p.organization_id, p.config_id)
        .await?
        .ok_or(BrokerError::ConfigNotFound)?;
    if config.project_id != p.project_id {
        return Err(BrokerError::ConfigNotFound);
    }
    let mut tx = pool.begin().await?;
    let head: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM config_secret_values WHERE config_id = ? AND key_name = ?",
    )
    .bind(p.config_id)
    .bind(p.key_name)
    .fetch_optional(&mut *tx)
    .await?;
    let last_version: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(version) FROM config_secret_value_versions \
         WHERE config_id = ? AND key_name = ?",
    )
    .bind(p.config_id)
    .bind(p.key_name)
    .fetch_one(&mut *tx)
    .await?;
    let next = head.unwrap_or(0).max(last_version.unwrap_or(0)) + 1;
    let aad = crate::crypto::config_value_ad(
        p.organization_id,
        p.project_id,
        p.config_id,
        p.key_name,
        next as u64,
    );
    let sealed = crate::crypto::seal_with_ad(key, &aad, p.plaintext)?;
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO config_secret_values (organization_id, project_id, config_id, key_name, \
         ciphertext, nonce, aad_digest, version, updated_by, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (config_id, key_name) DO UPDATE SET ciphertext = excluded.ciphertext, \
         nonce = excluded.nonce, aad_digest = excluded.aad_digest, version = excluded.version, \
         updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    )
    .bind(p.organization_id)
    .bind(p.project_id)
    .bind(p.config_id)
    .bind(p.key_name)
    .bind(&sealed.ciphertext)
    .bind(&sealed.nonce)
    .bind(&sealed.aad_digest)
    .bind(next)
    .bind(p.actor_id)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO config_secret_value_versions (config_id, key_name, version, ciphertext, \
         nonce, aad_digest, deleted, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(p.config_id)
    .bind(p.key_name)
    .bind(next)
    .bind(&sealed.ciphertext)
    .bind(&sealed.nonce)
    .bind(&sealed.aad_digest)
    .bind(p.actor_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    append_config_sync_outbox(
        &mut tx,
        "sync.config.dirty",
        p.organization_id,
        p.project_id,
        p.config_id,
    )
    .await?;
    append_backup_outbox(&mut tx, "config.value.changed", p.config_id, p.key_name).await?;
    tx.commit().await?;
    Ok(next as u64)
}

/// Tombstones the head value: appends a `deleted` versions row (empty
/// ciphertext — a tombstone has nothing to seal) and removes the head row, in
/// one transaction with the sync + backup outbox events.
pub async fn delete_config_value(
    pool: &SqlitePool,
    organization_id: &str,
    config_id: &str,
    key_name: &str,
    actor_id: Option<&str>,
) -> Result<bool> {
    ensure_secret_configs_schema(pool).await?;
    let Some(config) = get_secret_config(pool, organization_id, config_id).await? else {
        return Err(BrokerError::ConfigNotFound);
    };
    let mut tx = pool.begin().await?;
    let head: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM config_secret_values WHERE config_id = ? AND key_name = ?",
    )
    .bind(config_id)
    .bind(key_name)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(head) = head else {
        return Ok(false);
    };
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO config_secret_value_versions (config_id, key_name, version, ciphertext, \
         nonce, aad_digest, deleted, actor_id, created_at) VALUES (?, ?, ?, x'', x'', '', 1, ?, ?)",
    )
    .bind(config_id)
    .bind(key_name)
    .bind(head + 1)
    .bind(actor_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM config_secret_values WHERE config_id = ? AND key_name = ?")
        .bind(config_id)
        .bind(key_name)
        .execute(&mut *tx)
        .await?;
    append_config_sync_outbox(
        &mut tx,
        "sync.config.dirty",
        organization_id,
        &config.project_id,
        config_id,
    )
    .await?;
    append_backup_outbox(&mut tx, "config.value.deleted", config_id, key_name).await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn list_config_key_meta(
    pool: &SqlitePool,
    organization_id: &str,
    config_id: &str,
) -> Result<Vec<ConfigKeyMetaRow>> {
    ensure_secret_configs_schema(pool).await?;
    let rows = sqlx::query(
        "SELECT key_name, version, updated_at FROM config_secret_values \
         WHERE organization_id = ? AND config_id = ? ORDER BY key_name",
    )
    .bind(organization_id)
    .bind(config_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ConfigKeyMetaRow {
            key_name: r.get("key_name"),
            version: r.get("version"),
            updated_at: parse_time(&r.get::<String, _>("updated_at")),
        })
        .collect())
}

/// Ciphertext rows for in-process consumers only. Never serialize these onto
/// an API response.
pub async fn load_config_values_sealed(
    pool: &SqlitePool,
    organization_id: &str,
    config_id: &str,
) -> Result<Vec<ConfigValueRow>> {
    ensure_secret_configs_schema(pool).await?;
    let rows = sqlx::query(
        "SELECT key_name, version, ciphertext, nonce, aad_digest FROM config_secret_values \
         WHERE organization_id = ? AND config_id = ? ORDER BY key_name",
    )
    .bind(organization_id)
    .bind(config_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ConfigValueRow {
            key_name: r.get("key_name"),
            version: r.get("version"),
            sealed: SealedBlob {
                ciphertext: r.get("ciphertext"),
                nonce: r.get("nonce"),
                aad_digest: r.get("aad_digest"),
            },
        })
        .collect())
}

pub async fn list_config_value_versions(
    pool: &SqlitePool,
    organization_id: &str,
    config_id: &str,
    key_name: &str,
) -> Result<Vec<ConfigValueVersionMetaRow>> {
    ensure_secret_configs_schema(pool).await?;
    if get_secret_config(pool, organization_id, config_id)
        .await?
        .is_none()
    {
        return Err(BrokerError::ConfigNotFound);
    }
    let rows = sqlx::query(
        "SELECT version, deleted, actor_id, created_at FROM config_secret_value_versions \
         WHERE config_id = ? AND key_name = ? ORDER BY version DESC",
    )
    .bind(config_id)
    .bind(key_name)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ConfigValueVersionMetaRow {
            version: r.get("version"),
            deleted: r.get::<i64, _>("deleted") != 0,
            actor_id: r.get("actor_id"),
            created_at: parse_time(&r.get::<String, _>("created_at")),
        })
        .collect())
}

pub async fn get_config_value_version_sealed(
    pool: &SqlitePool,
    organization_id: &str,
    config_id: &str,
    key_name: &str,
    version: u64,
) -> Result<Option<ConfigValueRow>> {
    ensure_secret_configs_schema(pool).await?;
    if get_secret_config(pool, organization_id, config_id)
        .await?
        .is_none()
    {
        return Err(BrokerError::ConfigNotFound);
    }
    let row = sqlx::query(
        "SELECT key_name, version, ciphertext, nonce, aad_digest \
         FROM config_secret_value_versions \
         WHERE config_id = ? AND key_name = ? AND version = ? AND deleted = 0",
    )
    .bind(config_id)
    .bind(key_name)
    .bind(version as i64)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| ConfigValueRow {
        key_name: r.get("key_name"),
        version: r.get("version"),
        sealed: SealedBlob {
            ciphertext: r.get("ciphertext"),
            nonce: r.get("nonce"),
            aad_digest: r.get("aad_digest"),
        },
    }))
}

// ---- config sync outbox (sync actor wake queue) ----------------------------

pub async fn claim_config_sync_batch(
    pool: &SqlitePool,
    limit: i64,
    lease_seconds: i64,
) -> Result<Vec<ConfigSyncEventRow>> {
    ensure_secret_configs_schema(pool).await?;
    let now = Utc::now();
    let lease_until = (now + chrono::Duration::seconds(lease_seconds)).to_rfc3339();
    let mut tx = pool.begin().await?;
    let rows = sqlx::query(
        "SELECT id, event_type, organization_id, project_id, config_id, attempts, created_at \
         FROM config_sync_outbox \
         WHERE published_at IS NULL AND dead_lettered_at IS NULL \
           AND (available_at IS NULL OR available_at <= ?) \
         ORDER BY created_at LIMIT ?",
    )
    .bind(now.to_rfc3339())
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;
    let events: Vec<ConfigSyncEventRow> = rows
        .into_iter()
        .map(|r| ConfigSyncEventRow {
            id: r.get("id"),
            event_type: r.get("event_type"),
            organization_id: r.get("organization_id"),
            project_id: r.get("project_id"),
            config_id: r.get("config_id"),
            attempts: r.get::<i64, _>("attempts") + 1,
            created_at: parse_time(&r.get::<String, _>("created_at")),
        })
        .collect();
    for event in &events {
        sqlx::query(
            "UPDATE config_sync_outbox SET available_at = ?, attempts = attempts + 1 WHERE id = ?",
        )
        .bind(&lease_until)
        .bind(&event.id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(events)
}

pub async fn mark_config_sync_published(pool: &SqlitePool, ids: &[String]) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    for id in ids {
        sqlx::query("UPDATE config_sync_outbox SET published_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn park_config_sync(
    pool: &SqlitePool,
    ids: &[String],
    reason: &str,
    backoff_seconds: i64,
) -> Result<()> {
    let available = (Utc::now() + chrono::Duration::seconds(backoff_seconds)).to_rfc3339();
    for id in ids {
        sqlx::query(
            "UPDATE config_sync_outbox SET available_at = ?, last_error = ? \
             WHERE id = ? AND published_at IS NULL",
        )
        .bind(&available)
        .bind(reason)
        .bind(id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn dead_letter_config_sync(
    pool: &SqlitePool,
    ids: &[String],
    reason: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    for id in ids {
        sqlx::query(
            "UPDATE config_sync_outbox SET dead_lettered_at = ?, last_error = ? \
             WHERE id = ? AND published_at IS NULL",
        )
        .bind(&now)
        .bind(reason)
        .bind(id)
        .execute(pool)
        .await?;
    }
    Ok(())
}
