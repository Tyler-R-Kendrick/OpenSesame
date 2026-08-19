use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::require_operator;

#[derive(Deserialize)]
pub struct AuthorityBody {
    quorum_ok: bool,
}

pub async fn set_authority(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<AuthorityBody>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    if let Err(err) = st.db.set_authority_quorum(body.quorum_ok).await {
        tracing::error!(error = %err, "authority quorum write failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "quorum_write_failed"})),
        )
            .into_response();
    }
    Json(json!({"quorum_ok": body.quorum_ok})).into_response()
}
