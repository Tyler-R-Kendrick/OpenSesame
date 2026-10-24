//! Current authority for one frozen relay request, read inside its handoff transaction.

use chrono::{DateTime, Utc};
use opensesame_domain::Grant;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteRow, Row, SqliteConnection};

use super::relay::{expired, request_digest};

pub(super) struct LiveAuthority {
    pub digest: String,
    pub expires_at: DateTime<Utc>,
}

/// Resolve the exact frozen tuple, rather than a management listing or the
/// newest delegation for a connection. The caller owns the transaction.
pub(super) async fn resolve(
    connection: &mut SqliteConnection,
    request: &SqliteRow,
    now: DateTime<Utc>,
) -> Option<LiveAuthority> {
    let delegation = sqlx::query(
        "SELECT d.grant_id, d.parent_grant_id, d.expires_at
         FROM connection_delegations d
         JOIN connections c ON c.id = d.connection_id
         WHERE d.id = ? AND d.connection_id = ? AND d.organization_id = ?
           AND d.owner_subject = ? AND d.claimant_subject = ?
           AND d.revoked_at IS NULL AND d.execution_mode = 'relay'
           AND c.organization_id = d.organization_id AND c.owner_subject = d.owner_subject
           AND c.status = 'active'",
    )
    .bind(request.get::<String, _>("delegation_id"))
    .bind(request.get::<String, _>("connection_id"))
    .bind(request.get::<String, _>("organization_id"))
    .bind(request.get::<String, _>("holder_subject"))
    .bind(request.get::<String, _>("delegate_subject"))
    .fetch_optional(&mut *connection)
    .await
    .ok()??;
    let mut expires_at = DateTime::parse_from_rfc3339(&delegation.get::<String, _>("expires_at"))
        .ok()?
        .with_timezone(&Utc);
    if now >= expires_at || expired(&request.get::<String, _>("expires_at"), now) {
        return None;
    }
    let frozen_digest = request.get::<String, _>("request_digest");
    if !frozen_request_valid(request, &frozen_digest) {
        return None;
    }
    let mut grant_id: String = delegation.get("grant_id");
    let parent_id: String = delegation.get("parent_grant_id");
    let mut chain = Vec::new();
    for depth in 0..=32 {
        let row = sqlx::query("SELECT body_json, revoked_at FROM grants WHERE id = ?")
            .bind(&grant_id)
            .fetch_optional(&mut *connection)
            .await
            .ok()??;
        let grant: Grant = serde_json::from_str(&row.get::<String, _>("body_json")).ok()?;
        if row.get::<Option<String>, _>("revoked_at").is_some()
            || grant.id.to_string() != grant_id
            || grant.organization_id.to_string() != request.get::<String, _>("organization_id")
            || grant.assert_active(now).is_err()
            || !grant
                .actions
                .contains(&request.get::<String, _>("operation"))
            || !grant.permits_resource(&request.get::<String, _>("resource"))
        {
            return None;
        }
        if depth == 0
            && (grant.parent_grant_id.map(|id| id.to_string()).as_deref() != Some(&parent_id)
                || grant.connection_id.map(|id| id.to_string()).as_deref()
                    != Some(&request.get::<String, _>("connection_id")))
        {
            return None;
        }
        expires_at = expires_at.min(grant.constraints.expires_at);
        let parent = grant.parent_grant_id;
        chain.push(grant);
        if let Some(parent) = parent {
            grant_id = parent.to_string();
        } else {
            return Some(LiveAuthority {
                digest: authority_digest(request, &frozen_digest, &chain)?,
                expires_at,
            });
        }
    }
    None
}

fn frozen_request_valid(request: &SqliteRow, digest: &str) -> bool {
    let Ok(parameters) =
        serde_json::from_str::<Value>(&request.get::<String, _>("parameters_json"))
    else {
        return false;
    };
    request_digest(
        &request.get::<String, _>("delegation_id"),
        &request.get::<String, _>("operation"),
        &request.get::<String, _>("resource"),
        &parameters,
    )
    .is_ok_and(|computed| computed == digest)
}

fn authority_digest(request: &SqliteRow, frozen_digest: &str, chain: &[Grant]) -> Option<String> {
    let binding = json!({
        "domain": "opensesame:relay-authority:v1",
        "request_id": request.get::<String, _>("id"),
        "request_digest": frozen_digest,
        "delegation_id": request.get::<String, _>("delegation_id"),
        "connection_id": request.get::<String, _>("connection_id"),
        "organization_id": request.get::<String, _>("organization_id"),
        "holder_subject": request.get::<String, _>("holder_subject"),
        "delegate_subject": request.get::<String, _>("delegate_subject"),
        "chain": chain,
    });
    let bytes = serde_json::to_vec(&binding).ok()?;
    Some(format!("sha256:{:x}", Sha256::digest(bytes)))
}
