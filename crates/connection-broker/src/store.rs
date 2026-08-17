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
        egress: serde_json::from_str(&row.get::<String, _>("egress_json"))
            .unwrap_or_else(|_| EgressBinding::default()),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

const CONNECTION_COLUMNS: &str =
    "id, organization_id, project_id, provider_id, integration_id, logical_name, \
     display_name, status, status_detail, requested_scopes, granted_scopes, account_label, \
     owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, \
     updated_at";

pub async fn insert_connection(pool: &SqlitePool, c: &ConnectionRow) -> Result<()> {
    sqlx::query(
        "INSERT INTO connections (id, organization_id, project_id, provider_id, integration_id, logical_name, \
         display_name, status, status_detail, requested_scopes, granted_scopes, account_label, \
         owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, \
         updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
) -> Result<()> {
    let changed = sqlx::query(
        "UPDATE connections SET shareability = ?, max_invoke_level = ?, updated_at = ? \
         WHERE id = ? AND organization_id = ? AND status != 'revoked'",
    )
    .bind(shareability)
    .bind(max_invoke_level as i64)
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
    .bind(
        serde_json::json!({"connection_id": connection_id, "detail": detail}).to_string(),
    )
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
