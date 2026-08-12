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
use crate::middleware::auth::{caller, Caller};

fn owner_of(st: &AppState, id: &TaskRunId) -> Option<String> {
    st.task_owners.lock().ok()?.get(&id.to_string()).cloned()
}

/// Whether a session subject and a request's `principal_id` name the same
/// principal. Approval records whatever string the human approved as, so compare
/// raw first and then through the id parser, which tolerates the `principal:`
/// prefix and formatting differences.
fn names_same_principal(subject: &str, requested: &str) -> bool {
    if subject == requested {
        return true;
    }
    match (PrincipalId::parse(subject), PrincipalId::parse(requested)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// A task belonging to someone else reads as absent rather than forbidden, so
/// ids cannot be probed for existence.
#[allow(clippy::result_large_err)]
fn assert_owned(st: &AppState, who: &Caller, id: &TaskRunId) -> Result<(), Response> {
    if who.owns(owner_of(st, id).as_ref()) {
        return Ok(());
    }
    Err(not_found("task"))
}

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

/// Capabilities one ceiling may name. The whole set is canonicalized and digested
/// under the engine lock, which every other task route waits on, so the size of
/// that work is not a caller's to choose.
const MAX_CAPABILITIES: usize = 256;
/// Longest action or resource string in a capability.
const MAX_CAPABILITY_FIELD_LEN: usize = 512;
/// Longest a task may be allowed to live: 30 days. Also keeps the expiry sum
/// inside what a timestamp can hold.
const MAX_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
/// Largest frozen argument payload, serialized. Digested under the engine lock.
const MAX_ARGUMENTS_BYTES: usize = 64 * 1024;

/// Whether these capabilities are within what a ceiling may hold. Checked before
/// the engine lock is taken, so an oversized set costs no one else their turn.
#[allow(clippy::result_large_err)]
fn assert_capabilities_bounded(caps: &[CapabilityDto]) -> Result<(), Response> {
    if caps.len() > MAX_CAPABILITIES {
        return Err(err_json(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_many_capabilities",
            format!(
                "a ceiling may name at most {MAX_CAPABILITIES} capabilities; received {}",
                caps.len()
            ),
        ));
    }
    if caps.iter().any(|c| {
        c.action.len() > MAX_CAPABILITY_FIELD_LEN || c.resource.len() > MAX_CAPABILITY_FIELD_LEN
    }) {
        return Err(err_json(
            StatusCode::PAYLOAD_TOO_LARGE,
            "capability_field_too_long",
            format!("action and resource are at most {MAX_CAPABILITY_FIELD_LEN} bytes"),
        ));
    }
    Ok(())
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
    let who = caller(&st, &headers)?;
    // The ceiling and every intent frozen against it name this principal. A
    // session may only name the one it was approved as: owning the task handle
    // is not the same as being allowed to act as somebody else.
    if let Caller::Session(subject) = &who {
        if !names_same_principal(subject, &body.principal_id) {
            return Err(err_json(
                StatusCode::FORBIDDEN,
                "principal_not_session_subject",
                format!(
                    "this session acts as {subject}; approve a session as {} or use the operator token to start a task for it",
                    body.principal_id
                ),
            ));
        }
    }
    assert_capabilities_bounded(&body.capabilities)?;
    // Bounded before it is added to a timestamp: chrono panics on a duration this
    // far out, and a caller's number must not be able to stop the process.
    if body.ttl_seconds <= 0 || body.ttl_seconds > MAX_TTL_SECONDS {
        return Err(err_json(
            StatusCode::BAD_REQUEST,
            "ttl_out_of_range",
            format!("ttl_seconds must be between 1 and {MAX_TTL_SECONDS}"),
        ));
    }
    let principal = PrincipalId::parse(&body.principal_id).map_err(bad_req)?;
    let org = OrganizationId::parse(&body.organization_id).map_err(bad_req)?;
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
    let eng = st.task_engine.lock().map_err(|_| internal("lock"))?;
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
            maximum_expires_at: now + Duration::seconds(body.ttl_seconds),
            now,
        })
        .map_err(bad_req)?;
    // Record the owner before answering: the id is about to leave the process,
    // and an unowned task is one only an operator can reach afterwards.
    if let Caller::Session(subject) = &who {
        st.task_owners
            .lock()
            .map_err(|_| internal("lock"))?
            .insert(run.id.to_string(), subject.clone());
    }
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
    let who = caller(&st, &headers)?;
    let tid = TaskRunId::parse(&id).map_err(bad_req)?;
    // Under the engine lock, so a task started a moment ago is either fully
    // recorded or not there yet — never present but ownerless.
    let eng = st.task_engine.lock().map_err(|_| internal("lock"))?;
    assert_owned(&st, &who, &tid)?;
    let run = eng
        .store()
        .get_run(tid)
        .map_err(internal)?
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
    let who = caller(&st, &headers)?;
    let tid = TaskRunId::parse(&body.task_run_id).map_err(bad_req)?;
    // Sized before the lock: the arguments are canonicalized and digested while
    // every other task route waits, so how long that takes is not a caller's
    // to decide.
    let arguments_bytes = serde_json::to_string(&body.arguments)
        .map(|s| s.len())
        .unwrap_or(usize::MAX);
    if arguments_bytes > MAX_ARGUMENTS_BYTES {
        return Err(err_json(
            StatusCode::PAYLOAD_TOO_LARGE,
            "arguments_too_large",
            format!("frozen arguments are at most {MAX_ARGUMENTS_BYTES} bytes"),
        ));
    }
    let eng = st.task_engine.lock().map_err(|_| internal("lock"))?;
    // Freezing an intent spends a task's authority, so it is gated like reading
    // one: another session's task is not there to be spent.
    assert_owned(&st, &who, &tid)?;
    let required = Capability::new(
        body.operation.clone(),
        ResourceSelector::exact(body.resource.clone()),
    );
    let run = eng
        .assert_capability(tid, &required, body.expected_state_version)
        .map_err(|e| err_json(StatusCode::FORBIDDEN, "task_ceiling_exceeded", e))?;
    let now = Utc::now();
    let intent = FrozenIntentV2 {
        schema_version: FROZEN_INTENT_SCHEMA_VERSION,
        id: IntentId::new(),
        task_run_id: run.id,
        task_state_version: run.state_version,
        task_state_digest: run.state_digest.clone(),
        organization_id: run.organization_id,
        project_id: run.project_id,
        principal_id: run.principal_id,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
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
pub struct TerminateTaskBody {
    #[serde(default)]
    pub expected_state_version: Option<u64>,
}

pub async fn list_tasks(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Response, Response> {
    let who = caller(&st, &headers)?;
    let eng = st.task_engine.lock().map_err(|_| internal("lock"))?;
    let runs = eng.list_runs().map_err(internal)?;
    let items: Vec<Value> = runs
        .into_iter()
        .filter(|run| who.owns(owner_of(&st, &run.id).as_ref()))
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
    let who = caller(&st, &headers)?;
    let tid = TaskRunId::parse(&id).map_err(bad_req)?;
    let eng = st.task_engine.lock().map_err(|_| internal("lock"))?;
    assert_owned(&st, &who, &tid)?;
    let run = eng
        .store()
        .get_run(tid)
        .map_err(internal)?
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
    use super::{names_same_principal, Caller};

    #[test]
    fn a_session_may_only_name_its_own_principal() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        assert!(names_same_principal("user:demo", "user:demo"));
        // The prefix is presentation, not identity.
        assert!(names_same_principal(&format!("principal:{id}"), id));
        assert!(!names_same_principal(
            "user:demo",
            "550e8400-e29b-41d4-a716-446655440001"
        ));
        // A subject that is not a principal id cannot stand in for one.
        assert!(!names_same_principal("user:demo", id));
    }

    #[test]
    fn only_an_operator_reaches_an_unowned_task() {
        let session = Caller::Session("user:demo".into());
        assert!(session.owns(Some(&"user:demo".to_string())));
        assert!(!session.owns(Some(&"user:other".to_string())));
        assert!(!session.owns(None));
        assert!(Caller::Operator.owns(None));
    }
}
