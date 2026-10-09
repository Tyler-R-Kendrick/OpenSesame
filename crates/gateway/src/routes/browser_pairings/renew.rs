//! Keeping a join sitting's grant alive (ADR 0136 §2).
//!
//! A browser grant lasts five minutes. The join ceremony's last rung — read
//! what an invite offers, choose, join — can take a person longer than that,
//! and sending them back to the operator for a second approval of the same
//! browser is friction with no security in it. So a *join* grant, and only a
//! join grant, may be renewed: through the guard (so its token and `DPoP` proof
//! are already checked), to the same key and client, spending the old token,
//! and never past [`JOIN_SITTING`] after the operator approved it.

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_claims::hash_secret;
use serde_json::json;

use crate::{app_state::AppState, browser_pairing_proof::refusal};

/// The longest a join sitting lasts from the operator's approval.
pub(crate) const JOIN_SITTING: i64 = 30 * 60;

/// `POST /api/v1/browser-pairings/renew` — a fresh token for a join grant.
pub async fn renew(State(st): State<AppState>, headers: HeaderMap) -> Response {
    // Only a DPoP-bearing request reaches here through the guard; anything
    // else never proved it holds the grant's key, and is refused outright.
    let Some(raw) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("DPoP opaque-session:"))
        .filter(|value| value.len() == 64)
    else {
        return refusal("dpop_token_required");
    };
    let renewed = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let now = chrono::Utc::now().timestamp();
    let spent = hash_secret(raw);
    match st
        .db
        .renew_browser_grant(
            &spent,
            &hash_secret(&renewed),
            super::ceiling::JOIN_CEILING_JSON,
            JOIN_SITTING,
            now,
        )
        .await
    {
        Ok(Some((client_id, expires_at))) => {
            // The guard cached the spent token's claims; they go with it.
            if let Ok(mut sessions) = st.sessions.lock() {
                sessions.remove(&spent);
            }
            Json(json!({
                "access_token": format!("opaque-session:{renewed}"),
                "token_type": "DPoP",
                "expires_in": expires_at - now,
                "scope": "host.join",
                "client_id": client_id,
            }))
            .into_response()
        }
        // Not a join grant, or the sitting is over. Not a 401: the token in
        // hand still works until it lapses, and the page must not drop it.
        Ok(None) => (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "join_sitting_over"})),
        )
            .into_response(),
        Err(_) => refusal("grant_store_unavailable"),
    }
}

#[cfg(test)]
#[path = "renew_tests.rs"]
mod tests;
