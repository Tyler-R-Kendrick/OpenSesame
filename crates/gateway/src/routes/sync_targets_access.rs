//! Request authority is checked at materialization, not cached at dispatch.
use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::{
    config_access::{self, PolicyActor, ResourcePermission},
    BrokerError, CreateSyncTarget, SyncSecretSource, SyncTargetView,
};
use opensesame_domain::OrganizationId;
use serde_json::json;
use sqlx::SqlitePool;

use crate::app_state::AppState;
use crate::middleware::auth::Caller;
use crate::routes::connections::broker_error;
use crate::routes::secret_configs::access as secret_config_access;

pub(super) struct CallerSecretSource {
    pool: SqlitePool,
    organization: OrganizationId,
    actor: PolicyActor,
    inner: Arc<dyn SyncSecretSource>,
}

impl CallerSecretSource {
    pub(super) fn new(
        pool: SqlitePool,
        organization: OrganizationId,
        actor: PolicyActor,
        inner: Arc<dyn SyncSecretSource>,
    ) -> Self {
        Self {
            pool,
            organization,
            actor,
            inner,
        }
    }

    async fn check(&self, organization: &str, project: &str) -> Result<(), BrokerError> {
        if organization != self.organization.to_string() {
            return Err(BrokerError::ConfigNotFound);
        }
        match config_access::permits(
            &self.pool,
            &self.organization,
            &self.actor,
            project,
            ResourcePermission::Keys,
        )
        .await
        {
            Ok(true) => Ok(()),
            Ok(false) => Err(BrokerError::ConfigNotFound),
            Err(_) => Err(BrokerError::Storage(sqlx::Error::Protocol(
                "sync authorization lookup failed".into(),
            ))),
        }
    }
}

#[async_trait::async_trait]
impl SyncSecretSource for CallerSecretSource {
    async fn load_config_secrets(
        &self,
        organization_id: &str,
        project_id: &str,
        config_id: &str,
    ) -> Result<BTreeMap<String, String>, BrokerError> {
        self.check(organization_id, project_id).await?;
        let entries = self
            .inner
            .load_config_secrets(organization_id, project_id, config_id)
            .await?;
        // A revocation during the load must prevent the loaded snapshot from
        // reaching the broker's egress path. Every fan-out invocation repeats
        // both checks; the wrapper contains identity, never a cached allow.
        self.check(organization_id, project_id).await?;
        Ok(entries)
    }
}


pub(super) async fn require_project(
    st: &AppState,
    who: &Caller,
    organization: &OrganizationId,
    project: &str,
    permission: ResourcePermission,
) -> Result<(), Response> {
    secret_config_access::project(st, who, organization, project, permission).await
}

pub(super) async fn retain_authorized(
    st: &AppState,
    who: &Caller,
    organization: &OrganizationId,
    targets: Vec<SyncTargetView>,
) -> Result<Vec<SyncTargetView>, Response> {
    let mut authorized = Vec::new();
    for target in targets {
        match require_project(
            st,
            who,
            organization,
            &target.project_id,
            ResourcePermission::Manage,
        )
        .await
        {
            Ok(()) => authorized.push(target),
            Err(resp) if resp.status() == StatusCode::NOT_FOUND => {}
            // A policy outage must not masquerade as a successful list.
            Err(resp) => return Err(resp),
        }
    }
    Ok(authorized)
}

/// `POST /api/v1/sync-targets`
pub async fn create(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<super::CreateBody>,
) -> Response {
    let who = match super::authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = match super::caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = match secret_config_access::config(
        &st,
        &who,
        &organization_id,
        body.config_id.trim(),
        ResourcePermission::Manage,
    )
    .await
    {
        Ok(config) => config,
        Err(resp) => return resp,
    };
    if config.project_id != body.project_id.trim() {
        return secret_config_access::hidden();
    }
    let actor = match secret_config_access::actor(&who) {
        Ok(actor) => actor,
        Err(resp) => return resp,
    };
    match st
        .connection_broker
        .create_sync_target_for_actor(
            &organization_id,
            CreateSyncTarget {
                project_id: config.project_id,
                config_id: config.id,
                connection_id: body.connection_id,
                operation: body.operation,
            },
            &actor,
        )
        .await
    {
        Ok(target) => {
            let body = serde_json::to_value(&target).unwrap_or_else(|_| json!({}));
            if let Err(resp) = super::assert_no_secret_fields(&body) {
                return resp;
            }
            let _ = super::publish_sync_bus(
                &st,
                "sync.target.created",
                json!({
                    "target_id": target.id,
                    "project_id": target.project_id,
                    "config_id": target.config_id,
                    "provider_id": target.provider_id,
                }),
            )
            .await;
            (StatusCode::CREATED, Json(body)).into_response()
        }
        Err(e) => broker_error(&e),
    }
}

/// `GET /api/v1/sync-targets/{id}`
pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match super::authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = match super::caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let target = match st.connection_broker.get_sync_target(&organization_id, &id).await {
        Ok(target) => target,
        Err(e) => return broker_error(&e),
    };
    if let Err(resp) = require_project(
        &st,
        &who,
        &organization_id,
        &target.project_id,
        ResourcePermission::Manage,
    )
    .await
    {
        return resp;
    }
    let body = serde_json::to_value(&target).unwrap_or_else(|_| json!({}));
    if let Err(resp) = super::assert_no_secret_fields(&body) {
        return resp;
    }
    (StatusCode::OK, Json(body)).into_response()
}

/// `DELETE /api/v1/sync-targets/{id}`
pub async fn delete(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = match super::authorize(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization_id = match super::caller_organization(&st, &who, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let target = match st.connection_broker.get_sync_target(&organization_id, &id).await {
        Ok(target) => target,
        Err(e) => return broker_error(&e),
    };
    if let Err(resp) = require_project(
        &st,
        &who,
        &organization_id,
        &target.project_id,
        ResourcePermission::Manage,
    )
    .await
    {
        return resp;
    }
    match st
        .connection_broker
        .delete_sync_target(&organization_id, &id)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => broker_error(&e),
    }
}

#[cfg(test)]
#[path = "sync_targets_background_tests.rs"]
mod background_tests;
