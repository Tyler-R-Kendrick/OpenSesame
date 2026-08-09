//! Task-scoped Host API routes (immutable ceiling + frozen intents).

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use opensesame_domain::*;
use opensesame_task_access::{StartTaskParams, TaskStore};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::middleware::auth::{require_demo_bootstrap, resolve_caller, resolve_caller_subject};

/// Frozen intents awaiting execution; they expire in five minutes, so the map is
/// small by construction and capped to keep a chatty agent from growing it.
const MAX_FROZEN_INTENTS: usize = 512;

#[derive(Deserialize)]
pub struct StartTaskBody {
    pub principal_id: String,
    pub organization_id: String,
    pub capabilities: Vec<CapabilityDto>,
    #[serde(default = "default_ttl_secs")]
    pub ttl_seconds: i64,
}

fn default_ttl_secs() -> i64 {
    3600
}

/// The longest a task's authority may be asked to live. A day is already generous
/// for something meant to cover one unit of work.
const MAX_TASK_TTL_SECS: i64 = 24 * 60 * 60;

/// The most capabilities one ceiling may name. A ceiling is meant to be the small
/// list of things a task needs, and it is digested and carried on every intent.
const MAX_TASK_CAPABILITIES: usize = 64;

/// A TTL is a number the caller chose. Unbounded, it is either authority that
/// outlives any reason to trust it or, at the extremes of `i64`, arithmetic that
/// `chrono` refuses by panicking — taking the request down instead of answering it.
fn bounded_ttl(seconds: i64) -> Option<Duration> {
    if seconds <= 0 || seconds > MAX_TASK_TTL_SECS {
        return None;
    }
    Some(Duration::seconds(seconds))
}

#[derive(Deserialize, Clone)]
pub struct CapabilityDto {
    pub action: String,
    pub resource: String,
}

#[derive(Deserialize)]
pub struct FreezeIntentBody {
    pub task_run_id: String,
    pub expected_state_version: u64,
    pub operation: String,
    pub resource: String,
    pub audience: String,
    pub arguments: Value,
    pub idempotency_key: String,
}

pub async fn start_task(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<StartTaskBody>,
) -> Result<Response, Response> {
    let caller = resolve_caller(&st, &headers)?;
    let principal = PrincipalId::parse(&body.principal_id).map_err(bad_req)?;
    // A session cannot mint task authority for someone else's principal.
    if !caller.owns(&principal) {
        return Err(err_json(
            StatusCode::FORBIDDEN,
            "principal_mismatch",
            "task authority must be started for the calling principal",
        ));
    }
    let org = OrganizationId::parse(&body.organization_id).map_err(bad_req)?;
    let ttl = bounded_ttl(body.ttl_seconds).ok_or_else(|| {
        err_json(
            StatusCode::BAD_REQUEST,
            "ttl_out_of_range",
            "ttl_seconds must be between 1 and 86400",
        )
    })?;
    if body.capabilities.is_empty() || body.capabilities.len() > MAX_TASK_CAPABILITIES {
        return Err(err_json(
            StatusCode::BAD_REQUEST,
            "capability_count_out_of_range",
            "a task ceiling must name between 1 and 64 capabilities",
        ));
    }
    let caps = CapabilitySet::new(
        body.capabilities
            .into_iter()
            .map(|c| Capability::new(c.action, ResourceSelector::exact(c.resource)))
            .collect(),
    );
    let now = Utc::now();
    let ctx = AuthorityContext {
        id: AuthorityContextId::new(),
        mode: AuthorityContextMode::SinglePrincipal,
        organization_id: org,
        project_id: None,
        principal_ids: vec![principal],
        capability_ceiling: caps.clone(),
        compiled_at: now,
    };
    let eng = &st.task_engine;
    let ceiling = eng
        .compile_ceiling(
            vec![CeilingInput {
                principal_id: principal,
                capabilities: caps,
            }],
            now,
        )
        .map_err(bad_req)?;
    let run = eng
        .start_task(StartTaskParams {
            template_id: TaskTemplateId::new(),
            authority_context: ctx,
            ceiling: ceiling.clone(),
            maximum_expires_at: now + ttl,
            now,
        })
        .map_err(bad_req)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "task_run_id": run.id.to_string(),
            "state_version": run.state_version,
            "state_digest": run.state_digest,
            "ceiling_digest": ceiling.ceiling_digest,
            "status": "active",
            "capabilities": run.current_capabilities,
        })),
    )
        .into_response())
}

pub async fn get_task(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Response, Response> {
    let caller = resolve_caller(&st, &headers)?;
    let tid = TaskRunId::parse(&id).map_err(bad_req)?;
    let eng = &st.task_engine;
    let run = eng
        .store()
        .get_run(tid)
        .map_err(internal)?
        .filter(|run| caller.owns(&run.principal_id))
        .ok_or_else(|| not_found("task"))?;
    Ok(Json(json!({
        "task_run_id": run.id.to_string(),
        "state_version": run.state_version,
        "state_digest": run.state_digest,
        "status": run.status,
        "capability_ceiling": run.capability_ceiling,
        "current_capabilities": run.current_capabilities,
        "authority_context_id": run.authority_context_id.to_string(),
        "maximum_expires_at": run.maximum_expires_at,
    }))
    .into_response())
}

pub async fn freeze_intent(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<FreezeIntentBody>,
) -> Result<Response, Response> {
    let caller = resolve_caller(&st, &headers)?;
    let tid = TaskRunId::parse(&body.task_run_id).map_err(bad_req)?;
    let eng = &st.task_engine;
    // Freezing an intent spends another principal's ceiling unless we fence it here.
    eng.store()
        .get_run(tid)
        .map_err(internal)?
        .filter(|run| caller.owns(&run.principal_id))
        .ok_or_else(|| not_found("task"))?;
    let required = Capability::new(
        body.operation.clone(),
        ResourceSelector::exact(body.resource.clone()),
    );
    let now = Utc::now();
    let run = eng
        .assert_capability(tid, &required, body.expected_state_version, now)
        .map_err(|e| err_json(StatusCode::FORBIDDEN, "task_ceiling_exceeded", e))?;
    // Name the authority this intent will execute under. A fresh `ActorId::new()`
    // named nothing, so the receipt's actor was meaningless and a grant narrowed to
    // one actor, project or connection could not tell whether it covered the call.
    let boot = require_demo_bootstrap(&st)?;
    let intent = FrozenIntentV2 {
        schema_version: FROZEN_INTENT_SCHEMA_VERSION,
        id: IntentId::new(),
        task_run_id: run.id,
        task_state_version: run.state_version,
        task_state_digest: run.state_digest.clone(),
        organization_id: run.organization_id,
        project_id: run.project_id.or(Some(boot.project)),
        principal_id: run.principal_id,
        actor_id: boot.actor,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: Some(boot.connection),
        operation: body.operation,
        resource: body.resource,
        audience: body.audience,
        canonical_arguments: body.arguments,
        body_hash: None,
        nonce: uuid::Uuid::new_v4().to_string(),
        idempotency_key: body.idempotency_key,
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        intent_digest: String::new(),
    }
    .with_computed_digest()
    .map_err(bad_req)?;
    // Custody of the frozen bytes stays here: execution later names the digest,
    // it does not restate operation/resource/arguments.
    {
        let mut pending = st.frozen_intents.lock().map_err(|_| internal("lock"))?;
        pending.retain(|_, i| i.expires_at > now);
        if pending.len() >= MAX_FROZEN_INTENTS {
            return Err(err_json(
                StatusCode::TOO_MANY_REQUESTS,
                "frozen_intent_capacity",
                "too many unspent frozen intents",
            ));
        }
        pending.insert(intent.intent_digest.clone(), intent.clone());
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "intent_id": intent.id.to_string(),
            "intent_digest": intent.intent_digest,
            "task_run_id": intent.task_run_id.to_string(),
            "task_state_version": intent.task_state_version,
            "canonical_arguments": intent.canonical_arguments,
        })),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct InvokeTaskBody {
    /// Digest returned by `POST /api/v1/tasks/intents`.
    pub intent_digest: String,
}

/// Execute a frozen intent under its task ceiling.
///
/// The legacy `/api/v1/intents` path builds an intent from whatever the caller
/// sends, so a task-bound caller that used it spent no ceiling at all. Here the
/// digest names bytes the server already holds, and the broker re-asserts the
/// capability, task state version, and ceiling before anything executes.
/// Take a frozen intent for the caller, spending it only when it is theirs.
///
/// Single use: a spent digest cannot be replayed into a second invocation. The
/// ownership question is settled before the digest is spent — removing first
/// would let anyone who learned a digest burn another principal's intent and
/// collect a 404 for it, leaving the owner with nothing to invoke.
///
/// An intent that is absent and one that belongs to someone else are the same
/// answer here, so a caller cannot use this to enumerate other principals' work.
fn claim_frozen_intent(
    pending: &mut std::collections::HashMap<String, FrozenIntentV2>,
    digest: &str,
    caller: &crate::middleware::auth::Caller,
    now: chrono::DateTime<Utc>,
) -> Option<FrozenIntentV2> {
    pending.retain(|_, i| i.expires_at > now);
    if !caller.owns(&pending.get(digest)?.principal_id) {
        return None;
    }
    pending.remove(digest)
}

pub async fn invoke_task(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<InvokeTaskBody>,
) -> Result<Response, Response> {
    let caller = resolve_caller(&st, &headers)?;
    let subject = resolve_caller_subject(&st, &headers)?;
    let boot = require_demo_bootstrap(&st)?;
    let intent = {
        let mut pending = st.frozen_intents.lock().map_err(|_| internal("lock"))?;
        claim_frozen_intent(&mut pending, &body.intent_digest, &caller, Utc::now())
            .ok_or_else(|| not_found("frozen intent"))?
    };
    let required = Capability::new(
        intent.operation.clone(),
        ResourceSelector::exact(intent.resource.clone()),
    );
    let receipt = st
        .broker
        .invoke_frozen(
            &st.task_engine,
            opensesame_broker::FrozenInvokeInput {
                intent,
                grant: boot.grant.clone(),
                subject,
                connection_policy_id: "demo-conn".into(),
                required_capability: required,
            },
        )
        .await
        .map_err(|e| {
            err_json(
                StatusCode::FORBIDDEN,
                "frozen_invoke_denied",
                opensesame_redaction::redact_text(&e.to_string()),
            )
        })?;
    Ok((StatusCode::OK, Json(receipt)).into_response())
}

#[derive(Deserialize)]
pub struct TerminateTaskBody {
    #[serde(default)]
    pub expected_state_version: Option<u64>,
}

pub async fn list_tasks(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Response, Response> {
    let caller = resolve_caller(&st, &headers)?;
    let eng = &st.task_engine;
    let runs = eng.list_runs().map_err(internal)?;
    let items: Vec<Value> = runs
        .into_iter()
        .filter(|run| caller.owns(&run.principal_id))
        .map(|run| {
            json!({
                "task_run_id": run.id.to_string(),
                "state_version": run.state_version,
                "status": run.status,
                "principal_id": run.principal_id.to_string(),
            })
        })
        .collect();
    Ok(Json(json!({ "tasks": items })).into_response())
}

pub async fn terminate_task(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<TerminateTaskBody>,
) -> Result<Response, Response> {
    let caller = resolve_caller(&st, &headers)?;
    let tid = TaskRunId::parse(&id).map_err(bad_req)?;
    let eng = &st.task_engine;
    let run = eng
        .store()
        .get_run(tid)
        .map_err(internal)?
        .filter(|run| caller.owns(&run.principal_id))
        .ok_or_else(|| not_found("task"))?;
    let expected = body.expected_state_version.unwrap_or(run.state_version);
    let terminated = eng
        .terminate_task(tid, expected, Utc::now())
        .map_err(|e| err_json(StatusCode::CONFLICT, "terminate_failed", e))?;
    Ok((
        StatusCode::OK,
        Json(json!({
            "task_run_id": terminated.id.to_string(),
            "state_version": terminated.state_version,
            "status": "cancelled",
        })),
    )
        .into_response())
}

fn err_json(status: StatusCode, code: &str, detail: impl std::fmt::Display) -> Response {
    (
        status,
        Json(json!({"error": code, "detail": detail.to_string()})),
    )
        .into_response()
}

fn bad_req(e: impl std::fmt::Display) -> Response {
    err_json(StatusCode::BAD_REQUEST, "bad_request", e)
}

fn not_found(what: &str) -> Response {
    err_json(StatusCode::NOT_FOUND, "not_found", what)
}

fn internal(e: impl std::fmt::Display) -> Response {
    err_json(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", e)
}

#[cfg(test)]
mod tests {
    use super::claim_frozen_intent;
    use crate::middleware::auth::Caller;
    use chrono::{Duration, Utc};
    use opensesame_domain::{
        ActorId, FrozenIntentV2, IntentId, OrganizationId, PrincipalId, TaskRunId,
        FROZEN_INTENT_SCHEMA_VERSION,
    };
    use std::collections::HashMap;

    fn intent(principal: PrincipalId, expires_in_minutes: i64) -> FrozenIntentV2 {
        FrozenIntentV2 {
            schema_version: FROZEN_INTENT_SCHEMA_VERSION,
            id: IntentId::new(),
            task_run_id: TaskRunId::new(),
            task_state_version: 1,
            task_state_digest: "sha256:state".into(),
            organization_id: OrganizationId::new(),
            project_id: None,
            principal_id: principal,
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            connection_id: None,
            operation: "read".into(),
            resource: "repo:a".into(),
            audience: "https://api.example.com".into(),
            canonical_arguments: serde_json::json!({}),
            body_hash: None,
            nonce: "nonce".into(),
            idempotency_key: "idem".into(),
            issued_at: Utc::now(),
            expires_at: Utc::now() + Duration::minutes(expires_in_minutes),
            intent_digest: "sha256:intent".into(),
        }
    }

    #[test]
    fn a_caller_chosen_ttl_stays_inside_what_chrono_and_trust_allow() {
        assert!(super::bounded_ttl(3600).is_some());
        assert!(super::bounded_ttl(super::MAX_TASK_TTL_SECS).is_some());
        for refused in [0, -1, super::MAX_TASK_TTL_SECS + 1, i64::MAX, i64::MIN] {
            assert!(
                super::bounded_ttl(refused).is_none(),
                "{refused} should be refused"
            );
        }
        // Why the bound is checked before the duration is built: chrono answers an
        // out-of-range second count with a panic, not an error.
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let refused_by_chrono = std::panic::catch_unwind(|| Duration::seconds(i64::MAX)).is_err();
        std::panic::set_hook(hook);
        assert!(refused_by_chrono);
    }

    #[test]
    fn another_principal_cannot_burn_an_intent_it_does_not_own() {
        let owner = PrincipalId::new();
        let mut pending = HashMap::new();
        pending.insert("sha256:intent".to_string(), intent(owner, 5));

        let stranger = Caller::Principal(PrincipalId::new());
        assert!(
            claim_frozen_intent(&mut pending, "sha256:intent", &stranger, Utc::now()).is_none()
        );
        // The refusal must not have spent it.
        assert!(pending.contains_key("sha256:intent"));

        let owner_caller = Caller::Principal(owner);
        assert!(
            claim_frozen_intent(&mut pending, "sha256:intent", &owner_caller, Utc::now()).is_some()
        );
        assert!(pending.is_empty(), "the owner's invocation spends it");
    }

    #[test]
    fn an_unbound_session_claims_nothing() {
        let mut pending = HashMap::new();
        pending.insert("sha256:intent".to_string(), intent(PrincipalId::new(), 5));
        assert!(
            claim_frozen_intent(&mut pending, "sha256:intent", &Caller::Unbound, Utc::now())
                .is_none()
        );
        assert!(pending.contains_key("sha256:intent"));
    }

    #[test]
    fn expired_intents_are_dropped_rather_than_invoked() {
        let owner = PrincipalId::new();
        let mut pending = HashMap::new();
        pending.insert("sha256:intent".to_string(), intent(owner, -1));
        assert!(claim_frozen_intent(
            &mut pending,
            "sha256:intent",
            &Caller::Principal(owner),
            Utc::now()
        )
        .is_none());
        assert!(pending.is_empty());
    }

    #[test]
    fn operator_owns_every_principal() {
        assert!(Caller::Operator.owns(&PrincipalId::new()));
    }

    #[test]
    fn session_owns_only_its_own_principal() {
        let mine = PrincipalId::new();
        let theirs = PrincipalId::new();
        let caller = Caller::Principal(mine);
        assert!(caller.owns(&mine));
        assert!(!caller.owns(&theirs));
    }

    #[test]
    fn unbound_session_owns_nothing() {
        assert!(!Caller::Unbound.owns(&PrincipalId::new()));
    }
}
