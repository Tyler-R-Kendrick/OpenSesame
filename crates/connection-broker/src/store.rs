//! Turso persistence for the five connection tables.
//!
//! Everything here is row plumbing except `consume_authorization`, which enforces
//! the single-use, TTL-bound `state` the whole flow rests on.

use chrono::{DateTime, Utc};
use opensesame_domain::EgressBinding;
use opensesame_storage::Db;
use turso::{params, Row};

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

fn connection_from_row(row: &Row) -> Result<ConnectionRow> {
    Ok(ConnectionRow {
        id: row.get(0)?,
        organization_id: row.get(1)?,
        project_id: row.get(2)?,
        provider_id: row.get(3)?,
        logical_name: row.get(4)?,
        display_name: row.get(5)?,
        status: ConnectionStatus::parse(&row.get::<String>(6)?),
        status_detail: row.get(7)?,
        requested_scopes: parse_list(&row.get::<String>(8)?),
        granted_scopes: parse_list(&row.get::<String>(9)?),
        account_label: row.get(10)?,
        owner_kind: row.get(11)?,
        owner_subject: row.get(12)?,
        shareability: row.get(13)?,
        max_invoke_level: row.get::<i64>(14)?.clamp(1, 3) as u8,
        egress: serde_json::from_str(&row.get::<String>(15)?)
            .unwrap_or_else(|_| EgressBinding::default()),
        created_at: parse_time(&row.get::<String>(16)?),
        updated_at: parse_time(&row.get::<String>(17)?),
    })
}

const CONNECTION_COLUMNS: &str = "id, organization_id, project_id, provider_id, logical_name, \
     display_name, status, status_detail, requested_scopes, granted_scopes, account_label, \
     owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, \
     updated_at";

pub async fn insert_connection(db: &Db, c: &ConnectionRow) -> Result<()> {
    db.execute(
        "INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, \
         display_name, status, status_detail, requested_scopes, granted_scopes, account_label, \
         owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, \
         updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            c.id.clone(),
            c.organization_id.clone(),
            c.project_id.clone(),
            c.provider_id.clone(),
            c.logical_name.clone(),
            c.display_name.clone(),
            c.status.as_str(),
            c.status_detail.clone(),
            serde_json::to_string(&c.requested_scopes)?,
            serde_json::to_string(&c.granted_scopes)?,
            c.account_label.clone(),
            c.owner_kind.clone(),
            c.owner_subject.clone(),
            c.shareability.clone(),
            c.max_invoke_level as i64,
            serde_json::to_string(&c.egress)?,
            c.created_at.to_rfc3339(),
            c.updated_at.to_rfc3339()
        ],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

pub async fn get_connection(db: &Db, id: &str) -> Result<Option<ConnectionRow>> {
    let mut rows = db
        .query(
            format!("SELECT {CONNECTION_COLUMNS} FROM connections WHERE id = ?"),
            [id],
        )
        .await?;
    rows.next()
        .await?
        .as_ref()
        .map(connection_from_row)
        .transpose()
}

pub async fn list_connections(db: &Db, organization_id: &str) -> Result<Vec<ConnectionRow>> {
    let mut rows = db
        .query(
            format!("SELECT {CONNECTION_COLUMNS} FROM connections WHERE organization_id = ? ORDER BY created_at ASC"),
            [organization_id],
        )
        .await?;
    let mut connections = Vec::new();
    while let Some(row) = rows.next().await? {
        connections.push(connection_from_row(&row)?);
    }
    Ok(connections)
}

pub async fn logical_name_taken(
    db: &Db,
    organization_id: &str,
    logical_name: &str,
) -> Result<bool> {
    let mut rows = db
        .query(
            "SELECT 1 AS present FROM connections WHERE organization_id = ? AND logical_name = ?",
            params![organization_id, logical_name],
        )
        .await?;
    Ok(rows.next().await?.is_some())
}

pub async fn set_status(
    db: &Db,
    id: &str,
    status: ConnectionStatus,
    detail: Option<&str>,
) -> Result<()> {
    db.execute(
        "UPDATE connections SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?",
        params![status.as_str(), detail, Utc::now().to_rfc3339(), id],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

pub async fn set_grant_details(
    db: &Db,
    id: &str,
    granted_scopes: &[String],
    account_label: Option<&str>,
) -> Result<()> {
    db.execute(
        "UPDATE connections SET granted_scopes = ?, account_label = COALESCE(?, account_label), updated_at = ? WHERE id = ?",
        params![
            serde_json::to_string(granted_scopes)?,
            account_label,
            Utc::now().to_rfc3339(),
            id
        ],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

pub async fn set_requested_scopes(db: &Db, id: &str, scopes: &[String]) -> Result<()> {
    db.execute(
        "UPDATE connections SET requested_scopes = ?, updated_at = ? WHERE id = ?",
        params![serde_json::to_string(scopes)?, Utc::now().to_rfc3339(), id],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

pub async fn upsert_credential(db: &Db, c: &CredentialRow) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    db.execute(
        "INSERT INTO connection_credentials (connection_id, ciphertext, nonce, aad_digest, \
         token_type, expires_at, refreshable, last_refreshed_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(connection_id) DO UPDATE SET ciphertext = excluded.ciphertext, \
         nonce = excluded.nonce, aad_digest = excluded.aad_digest, token_type = excluded.token_type, \
         expires_at = excluded.expires_at, refreshable = excluded.refreshable, \
         last_refreshed_at = excluded.last_refreshed_at, updated_at = excluded.updated_at",
        params![
            c.connection_id.clone(),
            c.sealed.ciphertext.clone(),
            c.sealed.nonce.clone(),
            c.sealed.aad_digest.clone(),
            c.token_type.clone(),
            c.expires_at.map(|t| t.to_rfc3339()),
            i64::from(c.refreshable),
            c.last_refreshed_at.map(|t| t.to_rfc3339()),
            now.clone(),
            now
        ],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

pub async fn get_credential(db: &Db, connection_id: &str) -> Result<Option<CredentialRow>> {
    let mut rows = db
        .query(
            "SELECT connection_id, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, \
             last_refreshed_at FROM connection_credentials WHERE connection_id = ?",
            [connection_id],
        )
        .await?;
    let Some(r) = rows.next().await? else {
        return Ok(None);
    };
    Ok(Some(CredentialRow {
        connection_id: r.get(0)?,
        sealed: SealedBlob {
            ciphertext: r.get(1)?,
            nonce: r.get(2)?,
            aad_digest: r.get(3)?,
        },
        token_type: r.get(4)?,
        expires_at: r.get::<Option<String>>(5)?.map(|s| parse_time(&s)),
        refreshable: r.get::<i64>(6)? == 1,
        last_refreshed_at: r.get::<Option<String>>(7)?.map(|s| parse_time(&s)),
    }))
}

pub async fn delete_credential(db: &Db, connection_id: &str) -> Result<()> {
    db.execute(
        "DELETE FROM connection_credentials WHERE connection_id = ?",
        [connection_id],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

pub async fn insert_authorization(db: &Db, a: &AuthorizationRow) -> Result<()> {
    db.execute(
        "INSERT INTO connection_authorizations (state, connection_id, code_verifier, redirect_uri, \
         scopes, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
        params![
            a.state.clone(),
            a.connection_id.clone(),
            a.code_verifier.clone(),
            a.redirect_uri.clone(),
            serde_json::to_string(&a.scopes)?,
            Utc::now().to_rfc3339(),
            a.expires_at.to_rfc3339()
        ],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

/// Claims a `state` exactly once. The verifier is erased in the same statement
/// that marks consumption, so a replay finds nothing to exchange with — and a
/// concurrent replay loses the race rather than getting a second copy.
pub async fn consume_authorization(
    db: &Db,
    state: &str,
    now: DateTime<Utc>,
) -> Result<AuthorizationRow> {
    let mut conn = db.connection().await?;
    let tx = conn.transaction().await?;
    let mut rows = tx
        .query(
            "SELECT state, connection_id, code_verifier, redirect_uri, scopes, expires_at, consumed_at \
             FROM connection_authorizations WHERE state = ?",
            [state],
        )
        .await?;
    let row = rows.next().await?.ok_or(BrokerError::InvalidState)?;

    if row.get::<Option<String>>(6)?.is_some() {
        return Err(BrokerError::InvalidState);
    }
    let expires_at = parse_time(&row.get::<String>(5)?);
    if now >= expires_at {
        // Expiry is terminal for this state; clear the verifier rather than leave
        // it sitting in the table until something else prunes it.
        tx.execute(
            "UPDATE connection_authorizations SET code_verifier = '', consumed_at = ? WHERE state = ?",
            params![now.to_rfc3339(), state],
        )
        .await?;
        tx.commit().await?;
        db.after_write().await;
        return Err(BrokerError::StateExpired);
    }

    let claimed = tx
        .execute(
            "UPDATE connection_authorizations SET code_verifier = '', consumed_at = ? \
             WHERE state = ? AND consumed_at IS NULL",
            params![now.to_rfc3339(), state],
        )
        .await?;
    if claimed != 1 {
        return Err(BrokerError::InvalidState);
    }

    let authorization = AuthorizationRow {
        state: row.get(0)?,
        connection_id: row.get(1)?,
        code_verifier: row.get(2)?,
        redirect_uri: row.get(3)?,
        scopes: parse_list(&row.get::<String>(4)?),
        expires_at,
    };
    tx.commit().await?;
    db.after_write().await;
    Ok(authorization)
}

pub async fn insert_binding(
    db: &Db,
    connection_id: &str,
    kind: BindingTargetKind,
    target_id: &str,
    target_label: Option<&str>,
) -> Result<()> {
    let mut rows = db
        .query(
            "SELECT 1 AS present FROM connection_bindings WHERE connection_id = ? AND target_kind = ? AND target_id = ?",
            params![connection_id, kind.as_str(), target_id],
        )
        .await?;
    if rows.next().await?.is_some() {
        return Err(BrokerError::BindingExists);
    }
    db.execute(
        "INSERT INTO connection_bindings (id, connection_id, target_kind, target_id, target_label, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            uuid::Uuid::now_v7().to_string(),
            connection_id,
            kind.as_str(),
            target_id,
            target_label,
            Utc::now().to_rfc3339()
        ],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

pub async fn delete_binding(db: &Db, connection_id: &str, binding_id: &str) -> Result<()> {
    let deleted = db
        .execute(
            "DELETE FROM connection_bindings WHERE id = ? AND connection_id = ?",
            params![binding_id, connection_id],
        )
        .await?;
    if deleted == 0 {
        return Err(BrokerError::BindingNotFound);
    }
    db.after_write().await;
    Ok(())
}

pub async fn list_bindings(db: &Db, connection_id: &str) -> Result<Vec<BindingView>> {
    let mut rows = db
        .query(
            "SELECT id, target_kind, target_id, target_label, created_at FROM connection_bindings \
             WHERE connection_id = ? ORDER BY created_at ASC",
            [connection_id],
        )
        .await?;
    let mut bindings = Vec::new();
    while let Some(r) = rows.next().await? {
        bindings.push(BindingView {
            id: r.get(0)?,
            target_kind: BindingTargetKind::parse(&r.get::<String>(1)?)
                .unwrap_or(BindingTargetKind::Organization),
            target_id: r.get(2)?,
            target_label: r.get(3)?,
            created_at: r.get(4)?,
        });
    }
    Ok(bindings)
}

pub async fn append_event(
    db: &Db,
    connection_id: &str,
    kind: EventKind,
    detail: Option<&str>,
) -> Result<()> {
    db.execute(
        "INSERT INTO connection_events (id, connection_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)",
        params![
            uuid::Uuid::now_v7().to_string(),
            connection_id,
            kind.as_str(),
            detail,
            Utc::now().to_rfc3339()
        ],
    )
    .await?;
    db.after_write().await;
    Ok(())
}

pub async fn list_events(db: &Db, connection_id: &str) -> Result<Vec<EventView>> {
    let mut rows = db
        .query(
            "SELECT id, kind, detail, at FROM connection_events WHERE connection_id = ? ORDER BY at ASC, id ASC",
            [connection_id],
        )
        .await?;
    let mut events = Vec::new();
    while let Some(r) = rows.next().await? {
        events.push(EventView {
            id: r.get(0)?,
            kind: r.get(1)?,
            detail: r.get(2)?,
            at: r.get(3)?,
        });
    }
    Ok(events)
}
