//! Task-scoped Host API routes (immutable ceiling + frozen intents).

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use opensesame_domain::*;
use opensesame_task_access::{
    InMemoryTaskStore, StartTaskParams, TaskAccessEngine, TaskStore,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub type SharedTaskEngine = Arc<Mutex<TaskAccessEngine<InMemoryTaskStore>>>;

pub fn new_task_engine() -> SharedTaskEngine {
    Arc::new(Mutex::new(TaskAccessEngine::new(InMemoryTaskStore::new())))
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
    State(engine): State<SharedTaskEngine>,
    Json(body): Json<StartTaskBody>,
) -> Result<Response, Response> {
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
    let eng = engine.lock().map_err(|_| internal("lock"))?;
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
    State(engine): State<SharedTaskEngine>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Response, Response> {
    let tid = TaskRunId::parse(&id).map_err(bad_req)?;
    let eng = engine.lock().map_err(|_| internal("lock"))?;
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
    State(engine): State<SharedTaskEngine>,
    Json(body): Json<FreezeIntentBody>,
) -> Result<Response, Response> {
    let tid = TaskRunId::parse(&body.task_run_id).map_err(bad_req)?;
    let eng = engine.lock().map_err(|_| internal("lock"))?;
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
    State(engine): State<SharedTaskEngine>,
) -> Result<Response, Response> {
    let eng = engine.lock().map_err(|_| internal("lock"))?;
    let runs = eng.list_runs().map_err(internal)?;
    let items: Vec<Value> = runs
        .into_iter()
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
    State(engine): State<SharedTaskEngine>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<TerminateTaskBody>,
) -> Result<Response, Response> {
    let tid = TaskRunId::parse(&id).map_err(bad_req)?;
    let eng = engine.lock().map_err(|_| internal("lock"))?;
    let run = eng
        .store()
        .get_run(tid)
        .map_err(internal)?
        .ok_or_else(|| not_found("task"))?;
    let expected = body
        .expected_state_version
        .unwrap_or(run.state_version);
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
