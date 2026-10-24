//! `POST /api/v1/connections/{id}/mint` (ADR 0049; the AWS arm is ADR 0213).

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use super::{
    authorize, broker_error, caller_organization, caller_subject, owned, parse_body,
    require_integration_admin,
};
use crate::app_state::AppState;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MintBody {
    /// Numeric GitHub App installation ID (required for GitHub).
    pub installation_id: Option<String>,
    /// The lifetime asked for, in seconds. An AWS mint honours it from 900 up
    /// to its binding's cap and refuses anything outside; GitHub ignores it.
    pub duration_seconds: Option<u32>,
}

/// Administrator-only provider tokens. Connection ownership and
/// `derived_short_lived` remain required. Member delegation is denied until
/// installation/repository grants can attenuate tokens.
pub async fn mint(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    let who = match authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = organization_or_return!(&st, &who, &headers);
    if let Err(resp) = owned(&st, &who, &organization_id, &id).await {
        return resp;
    }
    if let Err(resp) = require_integration_admin(&who) {
        return resp;
    }
    let body: MintBody = match parse_body(&body) {
        Ok(body) => body,
        Err(resp) => return resp,
    };
    let actor = caller_subject(&who).unwrap_or_else(|| "operator".into());
    match st
        .connection_broker
        .mint_derived_token_for(
            &organization_id,
            &id,
            &actor,
            body.installation_id.as_deref(),
            body.duration_seconds,
        )
        .await
    {
        Ok(view) => Json(view).into_response(),
        Err(error) => broker_error(&error),
    }
}
