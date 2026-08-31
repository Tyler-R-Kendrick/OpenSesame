//! Shared sessions, participants and scoped grants over HTTP (ADR 0079).
//!
//! Every handler here follows the same three steps in the same order: resolve
//! the caller from the *transport*, read the session inside the caller's own
//! organization, and ask [`Reach`] what the caller may do. No handler takes a
//! principal from a request body — the body says what to do, never who is
//! asking.
//!
//! **Absence and refusal are the same answer.** A caller with no standing in a
//! session gets `404`, not `403`, and so does a caller naming a session that
//! does not exist. A `403` here would confirm that a private session exists,
//! which is most of what a stranger wants to learn about one. The one place
//! that is relaxed is the public discovery list, which advertises a name on
//! purpose (ADR 0079 §7) — and nothing else.
//!
//! **A participant is not shown another participant's scope.** The roster tells
//! a participant who else is in the session and in what role. Which *rows*
//! somebody else was given is the operator's business and stays in the
//! operator's view: a person granted three rows should not learn, from the
//! roster, that a colleague was granted the other four hundred.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{sse, IntoResponse, Response, Sse},
    Json,
};
use chrono::{DateTime, Utc};
use opensesame_domain::{
    GrantScope, JoinDecision, JoinRequest, JoinRequestId, NewSessionGrant, PrincipalId,
    SessionGrant, SessionGrantId, SessionId, SessionRole, SessionVisibility, VaultId, VaultItemId,
};
use opensesame_storage::StoredSession;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::middleware::auth::{parse_principal, resolve_caller, Caller};
use crate::session_channel::{Delivery, Recipient, SessionChannel, SessionEvent};
use crate::shared_session_fence::Reach;

/// The one refusal shape this module uses for "no".
///
/// Deliberately indistinguishable from "no such session": see the module note.
fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "session_not_found"})),
    )
        .into_response()
}

fn bad_request(code: &str, detail: &str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error": code, "detail": opensesame_redaction::redact_text(detail)})),
    )
        .into_response()
}

fn unavailable(error: &anyhow::Error) -> Response {
    tracing::warn!(%error, "shared session store unavailable");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error": "session_store_unavailable"})),
    )
        .into_response()
}

/// The caller as a named principal, or a refusal.
///
/// A shared session is between *people*, so every route here needs somebody it
/// can name in a grant and in a receipt. The gateway's operator token is a
/// machine credential with nobody behind it: letting it act as any session's
/// operator would be precisely the "operator can do anything" shortcut the
/// fence does not have. It is refused with its own code so the reason is
/// legible rather than looking like a missing session.
#[allow(clippy::result_large_err)]
fn caller_principal(
    caller: &Caller,
) -> Result<(PrincipalId, opensesame_domain::OrganizationId), Response> {
    let Caller::Session {
        subject,
        organization_id,
        ..
    } = caller
    else {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "session_principal_required",
                "hint": "shared sessions act for a named principal; an operator token has none"
            })),
        )
            .into_response());
    };
    parse_principal(subject)
        .map(|principal| (principal, *organization_id))
        .ok_or_else(|| {
            (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "session_principal_required"})),
            )
                .into_response()
        })
}

/// Resolve caller, session and standing in one step, so no handler can do two
/// of the three and forget the last.
async fn standing(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    raw_session_id: &str,
) -> Result<(PrincipalId, StoredSession, Reach), Response> {
    let caller = resolve_caller(st, headers)?;
    let (principal, organization) = caller_principal(&caller)?;
    let Ok(session_id) = SessionId::parse(raw_session_id) else {
        return Err(not_found());
    };
    let session = match st.db.session(&organization.to_string(), session_id).await {
        Ok(Some(session)) => session,
        Ok(None) => return Err(not_found()),
        Err(error) => return Err(unavailable(&error)),
    };
    let reach = Reach::of(&st.db, &session, principal, Utc::now()).await;
    Ok((principal, session, reach))
}

fn role_str(role: SessionRole) -> &'static str {
    match role {
        SessionRole::Read => "read",
        SessionRole::Write => "write",
    }
}

fn role_from(raw: &str) -> Option<SessionRole> {
    match raw {
        "read" => Some(SessionRole::Read),
        "write" => Some(SessionRole::Write),
        _ => None,
    }
}

fn visibility_str(visibility: SessionVisibility) -> &'static str {
    match visibility {
        SessionVisibility::Private => "private",
        SessionVisibility::Public => "public",
    }
}

/// What a participant is told about somebody else's grant.
///
/// Who, in what role, until when. **Not** the scope: which rows a colleague
/// can reach is not a participant's business, and publishing it would turn the
/// roster into a map of the vault for anybody admitted to a single row.
fn roster_entry(grant: &SessionGrant) -> Value {
    json!({
        "principal_id": grant.subject_principal_id.to_string(),
        "role": role_str(grant.role),
        "expires_at": grant.expires_at.to_rfc3339(),
    })
}

/// What the operator is told, which is everything they granted.
fn operator_entry(grant: &SessionGrant) -> Value {
    let mut entry = roster_entry(grant);
    let scope = match &grant.scope {
        GrantScope::Collection { vault_id } => json!({
            "kind": "collection",
            "vault_id": vault_id.to_string(),
        }),
        GrantScope::Rows { vault_id, items } => json!({
            "kind": "rows",
            "vault_id": vault_id.to_string(),
            "items": items.iter().map(ToString::to_string).collect::<Vec<_>>(),
        }),
    };
    if let Some(object) = entry.as_object_mut() {
        object.insert("grant_id".into(), json!(grant.id.to_string()));
        object.insert(
            "granted_by".into(),
            json!(grant.granted_by_principal_id.to_string()),
        );
        object.insert("scope".into(), scope);
    }
    entry
}

#[derive(Deserialize)]
pub struct OpenSessionRequest {
    display_name: String,
    /// `private` (default) or `public`. A public session accepts join
    /// requests from strangers; a private one is not discoverable at all.
    visibility: Option<String>,
}

/// `POST /api/v1/shared-sessions` — open one. The caller becomes its operator.
pub async fn open(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<OpenSessionRequest>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let (principal, organization) = match caller_principal(&caller) {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };

    let display_name = body.display_name.trim().to_string();
    if display_name.is_empty() || display_name.chars().count() > 120 {
        return bad_request("session_display_name", "1 to 120 characters");
    }
    let visibility = match body.visibility.as_deref() {
        None | Some("private") => SessionVisibility::Private,
        Some("public") => SessionVisibility::Public,
        Some(_) => return bad_request("session_visibility", "private or public"),
    };

    let session = StoredSession {
        id: SessionId::new(),
        organization_id: organization.to_string(),
        operator_principal_id: principal,
        display_name,
        visibility,
        created_at: Utc::now(),
        closed_at: None,
    };
    match st.db.create_session(&session).await {
        Ok(()) => (
            StatusCode::CREATED,
            Json(json!({
                "id": session.id.to_string(),
                "display_name": session.display_name,
                "visibility": visibility_str(session.visibility),
                "operator_principal_id": principal.to_string(),
                "created_at": session.created_at.to_rfc3339(),
            })),
        )
            .into_response(),
        Err(error) => unavailable(&error),
    }
}

#[derive(Deserialize)]
pub struct DiscoverQuery {
    visibility: Option<String>,
}

/// `GET /api/v1/shared-sessions?visibility=public` — the discovery record.
///
/// A name and an id. Not the vault, not the items, not the roster, not who
/// runs it (ADR 0079 §7). Private sessions are never listed here under any
/// query — the parameter is validated rather than defaulted, so a caller who
/// omits it gets a refusal instead of a listing they did not ask for.
pub async fn discover(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<DiscoverQuery>,
) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let (_, organization) = match caller_principal(&caller) {
        Ok(pair) => pair,
        Err(resp) => return resp,
    };
    if query.visibility.as_deref() != Some("public") {
        return bad_request(
            "session_visibility",
            "only public sessions are discoverable",
        );
    }
    match st.db.public_sessions(&organization.to_string()).await {
        Ok(sessions) => Json(json!({
            "sessions": sessions
                .iter()
                .map(|session| json!({
                    "id": session.id.to_string(),
                    "display_name": session.display_name,
                }))
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(error) => unavailable(&error),
    }
}

/// `GET /api/v1/shared-sessions/{id}` — the session and its roster.
///
/// Participants only. A pending join requester is not a participant and gets
/// the same `404` as a stranger: admission precedes connection.
pub async fn detail(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (_, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.may_see_session() {
        return not_found();
    }
    let grants = match st.db.active_session_grants(session.id, Utc::now()).await {
        Ok(grants) => grants,
        Err(error) => return unavailable(&error),
    };
    let participants: Vec<Value> = if reach.is_operator() {
        grants.iter().map(operator_entry).collect()
    } else {
        grants.iter().map(roster_entry).collect()
    };
    Json(json!({
        "id": session.id.to_string(),
        "display_name": session.display_name,
        "visibility": visibility_str(session.visibility),
        "operator_principal_id": session.operator_principal_id.to_string(),
        "created_at": session.created_at.to_rfc3339(),
        "closed_at": session.closed_at.map(|at| at.to_rfc3339()),
        "participants": participants,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct ScopeBody {
    kind: String,
    vault_id: String,
    #[serde(default)]
    items: Vec<String>,
}

#[derive(Deserialize)]
pub struct GrantRequest {
    /// Who the grant is for. Required when granting directly; **refused** when
    /// admitting a join request, where the requester is the only possible
    /// subject and a second opinion in the body could only be a mistake or an
    /// attempt to admit one person and grant another.
    subject_principal_id: Option<String>,
    scope: ScopeBody,
    role: String,
    /// When the grant lapses. Refused, never clamped, if it is outside the
    /// domain's bounds — silently shortening it would leave the operator
    /// believing something the system did not do (ADR 0079 §3).
    expires_at: String,
}

/// Build a validated grant from a request body, for a subject the *caller*
/// decides.
///
/// The subject is a parameter rather than a body field on purpose. Admitting a
/// join request mints a grant for the requester, and passing the requester in
/// here is what makes "admit Alice, grant Bob" unrepresentable rather than
/// merely unlikely.
///
/// `granted_at` is the server's clock, never the body's: a client that could
/// set the start of the window could set it in the past and buy itself a
/// longer one than the seven-day ceiling allows.
#[allow(clippy::result_large_err)]
fn grant_from(
    body: &GrantRequest,
    session_id: SessionId,
    subject: PrincipalId,
    granted_by: PrincipalId,
    now: DateTime<Utc>,
) -> Result<SessionGrant, Response> {
    let Ok(vault_id) = VaultId::parse(&body.scope.vault_id) else {
        return Err(bad_request("grant_scope", "not a vault id"));
    };
    let scope = match body.scope.kind.as_str() {
        "collection" => GrantScope::Collection { vault_id },
        "rows" => {
            let mut items = std::collections::BTreeSet::new();
            for raw in &body.scope.items {
                let Ok(item) = VaultItemId::parse(raw) else {
                    return Err(bad_request("grant_scope", "not an item id"));
                };
                items.insert(item);
            }
            GrantScope::Rows { vault_id, items }
        }
        _ => return Err(bad_request("grant_scope", "collection or rows")),
    };
    let Some(role) = role_from(&body.role) else {
        return Err(bad_request("grant_role", "read or write"));
    };
    let Ok(expires_at) = DateTime::parse_from_rfc3339(&body.expires_at) else {
        return Err(bad_request("grant_expiry", "not an RFC3339 timestamp"));
    };

    SessionGrant::new(NewSessionGrant {
        id: SessionGrantId::new(),
        session_id,
        subject_principal_id: subject,
        granted_by_principal_id: granted_by,
        scope,
        role,
        granted_at: now,
        expires_at: expires_at.with_timezone(&Utc),
    })
    .map_err(|error| bad_request("grant_refused", &error.to_string()))
}

/// `POST /api/v1/shared-sessions/{id}/grants` — the operator gives reach.
pub async fn grant(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<GrantRequest>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.is_operator() {
        return not_found();
    }
    if session.closed_at.is_some() {
        return bad_request("session_closed", "a closed session grants nothing");
    }
    let Some(subject) = body
        .subject_principal_id
        .as_deref()
        .and_then(parse_principal)
    else {
        return bad_request("grant_subject", "not a principal id");
    };
    let minted = match grant_from(&body, session.id, subject, principal, Utc::now()) {
        Ok(grant) => grant,
        Err(resp) => return resp,
    };
    match st
        .db
        .insert_session_grant(&session.organization_id, &minted)
        .await
    {
        Ok(()) => {
            announce(
                &st,
                session.id,
                SessionEvent::GrantAdded {
                    grant_id: minted.id,
                    subject_principal_id: minted.subject_principal_id,
                    role: minted.role,
                    expires_at: minted.expires_at,
                },
            );
            (
                StatusCode::CREATED,
                Json(json!({"grant": operator_entry(&minted)})),
            )
                .into_response()
        }
        Err(error) => unavailable(&error),
    }
}

/// `DELETE /api/v1/shared-sessions/{id}/grants/{grant_id}` — withdraw it.
///
/// Idempotent: revoking an already-revoked grant is `204`, because the caller's
/// intent — "this person must not have this any more" — is satisfied either
/// way, and a `409` would only invite a retry loop.
///
/// The response says what revocation does *not* undo. A participant who held a
/// wrapped item key and copied the ciphertext keeps the ability to read that
/// version; withdrawing stops new authorizations and re-keying is what makes
/// future versions unreadable (ADR 0079 §3). Saying so on the wire is cheaper
/// than a support conversation after the fact.
pub async fn revoke(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((id, grant_id)): Path<(String, String)>,
) -> Response {
    let (_, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.is_operator() {
        return not_found();
    }
    let Ok(grant_id) = SessionGrantId::parse(&grant_id) else {
        return not_found();
    };
    // Read it first so a grant on somebody *else's* session cannot be revoked
    // by naming it under a session this caller does run.
    let withdrawn_from = match st
        .db
        .session_grant(&session.organization_id, grant_id)
        .await
    {
        Ok(Some(found)) if found.session_id == session.id => found.subject_principal_id,
        Ok(_) => return not_found(),
        Err(error) => return unavailable(&error),
    };
    match st.db.revoke_session_grant(grant_id, Utc::now()).await {
        Ok(_) => {
            announce(
                &st,
                session.id,
                SessionEvent::GrantWithdrawn {
                    grant_id,
                    subject_principal_id: withdrawn_from,
                },
            );
            Json(json!({
            "revoked": true,
            "note": "New authorizations stop now. Re-key the vault or the row to make future versions unreadable to a former participant who kept ciphertext.",
            }))
            .into_response()
        }
        Err(error) => unavailable(&error),
    }
}

#[derive(Deserialize)]
pub struct AskToJoinRequest {
    note: Option<String>,
}

/// `POST /api/v1/shared-sessions/{id}/join-requests` — a stranger asks in.
///
/// Only a public session accepts one. A private session answers `404` to a
/// non-participant here exactly as it does everywhere else, so this route
/// cannot be used to probe for private sessions by id.
pub async fn ask_to_join(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<AskToJoinRequest>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if session.visibility != SessionVisibility::Public && !reach.may_see_session() {
        return not_found();
    }
    if session.closed_at.is_some() {
        return not_found();
    }
    if reach.may_see_session() {
        return bad_request("already_in_session", "you are already in this session");
    }

    let request = match JoinRequest::new(
        JoinRequestId::new(),
        session.id,
        principal,
        body.note.clone(),
        Utc::now(),
    ) {
        Ok(request) => request,
        Err(error) => return bad_request("join_request_refused", &error.to_string()),
    };
    match st
        .db
        .insert_join_request(&session.organization_id, &request)
        .await
    {
        // The requester learns their request is pending and nothing else: no
        // roster, no channel, no peer (ADR 0079 §7).
        Ok(()) => {
            announce(
                &st,
                session.id,
                SessionEvent::JoinRequested {
                    request_id: request.id,
                },
            );
            (
                StatusCode::ACCEPTED,
                Json(json!({"id": request.id.to_string(), "decision": "pending"})),
            )
                .into_response()
        }
        Err(error) => {
            // The partial unique index refuses a second pending ask from the
            // same principal. Asking twice is the same ask, so report the
            // state rather than an error.
            tracing::debug!(%error, "join request refused by the store");
            (
                StatusCode::CONFLICT,
                Json(json!({"error": "join_request_pending"})),
            )
                .into_response()
        }
    }
}

/// `GET /api/v1/shared-sessions/{id}/join-requests` — who is waiting.
pub async fn list_join_requests(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (_, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.is_operator() {
        return not_found();
    }
    match st.db.pending_join_requests(session.id).await {
        Ok(requests) => Json(json!({
            "requests": requests
                .iter()
                .map(|request| json!({
                    "id": request.id.to_string(),
                    "requester_principal_id": request.requester_principal_id.to_string(),
                    // Untrusted text written by somebody with no standing in
                    // the session. Bounded by the domain at 280 characters;
                    // whatever renders it escapes it.
                    "note": request.note,
                    "requested_at": request.requested_at.to_rfc3339(),
                }))
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(error) => unavailable(&error),
    }
}

#[derive(Deserialize)]
pub struct DecideRequest {
    /// `admitted` or `refused`.
    decision: String,
    /// Required for `admitted`, forbidden for `refused`: admission *is* a
    /// grant, and one without the other is the shape that lets the roster and
    /// the request log disagree.
    grant: Option<GrantRequest>,
}

/// `POST /api/v1/shared-sessions/{id}/join-requests/{request_id}/decide`
pub async fn decide_join_request(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((id, request_id)): Path<(String, String)>,
    Json(body): Json<DecideRequest>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.is_operator() {
        return not_found();
    }
    let Ok(request_id) = JoinRequestId::parse(&request_id) else {
        return not_found();
    };
    let waiting = match st
        .db
        .join_request(&session.organization_id, request_id)
        .await
    {
        Ok(Some(found)) if found.session_id == session.id => found,
        Ok(_) => return not_found(),
        Err(error) => return unavailable(&error),
    };
    if waiting.decision != JoinDecision::Pending {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error": "join_request_decided"})),
        )
            .into_response();
    }

    let now = Utc::now();
    let (decision, minted) = match (body.decision.as_str(), body.grant.as_ref()) {
        ("refused", None) => (JoinDecision::Refused, None),
        ("refused", Some(_)) => {
            return bad_request("decision_shape", "a refusal mints no grant");
        }
        ("admitted", Some(spec)) => {
            if spec.subject_principal_id.is_some() {
                return bad_request(
                    "decision_shape",
                    "an admission grants the requester; naming another subject is refused",
                );
            }
            // The requester is the subject, structurally: `grant_from` takes it
            // as a parameter, so there is no body field that could disagree.
            match grant_from(
                spec,
                session.id,
                waiting.requester_principal_id,
                principal,
                now,
            ) {
                Ok(grant) => (JoinDecision::Admitted { grant_id: grant.id }, Some(grant)),
                Err(resp) => return resp,
            }
        }
        ("admitted", None) => {
            return bad_request("decision_shape", "admission needs the grant it mints");
        }
        _ => return bad_request("decision_shape", "admitted or refused"),
    };

    match st
        .db
        .decide_join_request(
            &session.organization_id,
            request_id,
            decision,
            principal,
            now,
            minted.as_ref(),
        )
        .await
    {
        Ok(()) => {
            if let Some(grant) = minted.as_ref() {
                announce(
                    &st,
                    session.id,
                    SessionEvent::GrantAdded {
                        grant_id: grant.id,
                        subject_principal_id: grant.subject_principal_id,
                        role: grant.role,
                        expires_at: grant.expires_at,
                    },
                );
            }
            Json(json!({
                "id": request_id.to_string(),
                "decision": if minted.is_some() { "admitted" } else { "refused" },
                "grant": minted.as_ref().map(operator_entry),
            }))
            .into_response()
        }
        Err(error) => unavailable(&error),
    }
}

/// Announce something on the session's channel, if anybody is listening.
///
/// Best-effort by design. The store is the record and the channel is a
/// courtesy: a route that failed to publish has still done what it was asked,
/// and a route that refused to act because nobody was listening would be
/// worse. Publishing never widens anybody's reach — every event still passes
/// [`Delivery::for_recipient`] against live grants before it reaches a reader.
fn announce(st: &AppState, session_id: SessionId, event: SessionEvent) {
    let channels = st.session_channels.lock().unwrap();
    if let Some(channel) = channels.get(&session_id) {
        channel.publish(event);
    }
}

#[derive(Deserialize)]
pub struct ActivityRequest {
    /// `opened` or `changed`.
    kind: String,
    vault_id: String,
    item_id: String,
}

/// `POST /api/v1/shared-sessions/{id}/activity` — tell the room what you are on.
///
/// The one thing a participant *sends*, and it is a request like any other:
/// the announcer's own reach is checked before anything is broadcast, so a
/// participant cannot manufacture activity for an item they were never
/// granted. The refusal is the same `404` the rest of the module uses, because
/// distinguishing "no such item" from "not yours" would turn this into an
/// oracle for what the vault holds.
///
/// It carries ids and nothing else. What the item is called is rendered by
/// each client from what that client can already decrypt.
pub async fn announce_activity(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ActivityRequest>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.may_see_session() {
        return not_found();
    }
    let (Ok(vault_id), Ok(item_id)) = (
        VaultId::parse(&body.vault_id),
        VaultItemId::parse(&body.item_id),
    ) else {
        return bad_request("activity_target", "not a vault and item id");
    };
    let wanted = match body.kind.as_str() {
        "opened" => SessionRole::Read,
        "changed" => SessionRole::Write,
        _ => return bad_request("activity_kind", "opened or changed"),
    };

    let now = Utc::now();
    let grants = match st.db.active_grants_for(session.id, principal, now).await {
        Ok(grants) => grants,
        Err(error) => return unavailable(&error),
    };
    if crate::shared_session_fence::authorizing_grant(
        &grants, principal, vault_id, item_id, wanted, now,
    )
    .is_none()
    {
        return not_found();
    }

    let event = if wanted == SessionRole::Write {
        SessionEvent::ItemChanged {
            vault_id,
            item_id,
            by_principal_id: principal,
        }
    } else {
        SessionEvent::ItemOpened {
            vault_id,
            item_id,
            by_principal_id: principal,
        }
    };
    announce(&st, session.id, event);
    StatusCode::ACCEPTED.into_response()
}

/// Publishes a departure when a reader's stream ends, however it ends.
///
/// A `Drop` guard rather than a tidy-up at the end of the loop: a browser tab
/// closing, a network drop and a cancelled request all unwind rather than
/// returning, and presence that only updated on a graceful exit would show
/// people in the room who left hours ago.
struct Presence {
    state: AppState,
    session_id: SessionId,
    principal_id: PrincipalId,
}

impl Drop for Presence {
    fn drop(&mut self) {
        announce(
            &self.state,
            self.session_id,
            SessionEvent::ParticipantLeft {
                principal_id: self.principal_id,
            },
        );
    }
}

/// `GET /api/v1/shared-sessions/{id}/events` — the session's live channel.
///
/// Server-sent events, one direction only. That is the security decision in
/// this handler rather than an implementation convenience: ADR 0079 §6 says an
/// inbound message is a request like any other and never evidence its sender
/// is allowed, and the cheapest way to hold that rule is to have no inbound
/// frame path at all. Everything a participant *does* goes through the
/// authenticated routes above, where the fence already runs.
///
/// Standing is re-read from the store on every event rather than captured at
/// subscribe time. A subscription is not a permission: a participant whose
/// grant is withdrawn or lapses mid-stream stops receiving on the next event,
/// not at their next reconnect.
pub async fn events(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.may_see_session() {
        return not_found();
    }
    let is_operator = reach.is_operator();

    let receiver = {
        let mut channels = st.session_channels.lock().unwrap();
        // Sessions with no reader are dropped when their last one leaves, so
        // the map holds live channels rather than a row per session ever
        // opened.
        channels.retain(|_, channel| !channel.is_idle());
        channels
            .entry(session.id)
            .or_insert_with(SessionChannel::new)
            .subscribe()
    };

    let session_id = session.id;
    announce(
        &st,
        session_id,
        SessionEvent::ParticipantJoined {
            principal_id: principal,
            role: if is_operator {
                SessionRole::Write
            } else {
                SessionRole::Read
            },
        },
    );
    let presence = Presence {
        state: st.clone(),
        session_id,
        principal_id: principal,
    };

    // `unfold` rather than a generator macro: the loop's state is exactly the
    // receiver, and the per-event standing read is an ordinary await inside it.
    let stream = futures::stream::unfold(
        (receiver, st.clone(), presence),
        move |(mut receiver, st, presence)| async move {
            loop {
                let event = match receiver.recv().await {
                    Ok(event) => event,
                    // A reader that fell behind is told how far and keeps its
                    // place. It never grows the buffer for anybody else.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                        let notice = sse::Event::default()
                            .event("lagged")
                            .data(missed.to_string());
                        return Some((
                            Ok::<_, std::convert::Infallible>(notice),
                            (receiver, st, presence),
                        ));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                };

                let now = Utc::now();
                // Read afresh: a subscription is not a permission, and a grant
                // withdrawn mid-stream must stop delivery on the next event
                // rather than at the next reconnect. A read that fails yields
                // no grants, which denies — the same rule the fence uses.
                let grants = st
                    .db
                    .active_grants_for(session_id, principal, now)
                    .await
                    .unwrap_or_default();
                let recipient = Recipient {
                    principal_id: principal,
                    is_operator,
                    grants,
                };
                if !Delivery::for_recipient(&event, &recipient, now) {
                    continue;
                }
                match serde_json::to_string(&event) {
                    Ok(payload) => {
                        let frame = sse::Event::default().data(payload);
                        return Some((Ok(frame), (receiver, st, presence)));
                    }
                    Err(error) => {
                        tracing::warn!(%error, "session event would not serialize");
                    }
                }
            }
        },
    );

    Sse::new(stream)
        .keep_alive(sse::KeepAlive::default())
        .into_response()
}

#[cfg(test)]
#[path = "shared_sessions/tests.rs"]
mod tests;
