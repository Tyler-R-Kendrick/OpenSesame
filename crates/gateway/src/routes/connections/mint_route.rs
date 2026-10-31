//! `POST /api/v1/connections/{id}/mint` (ADR 0049; the AWS arm is ADR 0217).

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
    /// The process the daemon minted for, when a credential helper asked on
    /// its Unix socket (ADR 0138 §2). It authorizes nothing: the caller is
    /// still the one `authorize` resolved. It names who asked, in the receipt.
    pub on_behalf_of: Option<OnBehalfOf>,
}

/// A local process, by the credentials its kernel attested to the daemon.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OnBehalfOf {
    pub uid: u32,
    pub pid: u32,
}

/// The RFC 8693 actor recorded for a mint: the caller, and the local process
/// it minted for when there is one (`operator on_behalf_of=uid:1000,pid:4242`).
fn mint_actor(caller: String, on_behalf_of: Option<&OnBehalfOf>) -> String {
    match on_behalf_of {
        Some(peer) => format!("{caller} on_behalf_of=uid:{},pid:{}", peer.uid, peer.pid),
        None => caller,
    }
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
    let principal = caller_subject(&who).unwrap_or_else(|| "operator".into());
    let actor = mint_actor(principal.clone(), body.on_behalf_of.as_ref());
    // The provider hears the principal; the receipt and event record the actor.
    let caller = opensesame_connection_broker::MintCaller {
        principal: &principal,
        actor: &actor,
    };
    match st
        .connection_broker
        .mint_derived_token_for(
            &organization_id,
            &id,
            caller,
            body.installation_id.as_deref(),
            body.duration_seconds,
        )
        .await
    {
        Ok(view) => Json(view).into_response(),
        Err(error) => broker_error(&error),
    }
}
