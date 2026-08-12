use crate::bootstrap;
use crate::config::{self, Args};
use crate::task_engine::{new_task_engine, SharedTaskEngine};
use opensesame_broker::Broker;
use opensesame_connection_broker::{catalog, BrokerConfig, ConnectionBroker};
use opensesame_domain::*;
use opensesame_provider_openbao::OpenBaoHttpAuthority;
use opensesame_provider_openfga::OpenFgaClient;
use opensesame_storage::Db;
use opensesame_task_access::{
    distributed_task_authority_ok, is_postgres_database_url, PostgresTaskStore,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use opensesame_client_core::SyncBlob;

#[derive(Clone)]
pub struct DevicePending {
    /// `hash_secret(user_code)` — the low-entropy code is never held in cleartext.
    pub user_code_hash: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub approved_principal: Option<String>,
    /// Failed approval attempts against this code (brute-force fence).
    pub approve_attempts: u32,
}

#[derive(Clone)]
pub struct Bootstrap {
    pub org: OrganizationId,
    pub project: ProjectId,
    pub principal: PrincipalId,
    pub actor: ActorId,
    pub connection: ConnectionId,
    pub grant: Grant,
}

#[derive(Clone)]
pub struct AppState {
    pub resource: String,
    pub issuer: String,
    pub db: Db,
    pub broker: Arc<Broker>,
    pub sessions: Arc<Mutex<HashMap<String, Value>>>,
    pub device_codes: Arc<Mutex<HashMap<String, DevicePending>>>,
    pub claims: Arc<Mutex<HashMap<String, ClaimSession>>>,
    pub bootstrap: Arc<Mutex<Option<Bootstrap>>>,
    pub openfga: Option<OpenFgaClient>,
    pub openbao: Option<OpenBaoHttpAuthority>,
    pub connection_ref: Option<ConnectionRef>,
    /// Third-party service authorizations (ADR 0032).
    pub connection_broker: Arc<ConnectionBroker>,
    /// Organization connections are created under. Until the gateway carries an
    /// org per caller, that is the demo bootstrap's org or a fixed single-tenant id.
    pub connection_organization: OrganizationId,
    /// Opaque ciphertext sync store — server never decrypts (ADR 0017).
    pub sync_blobs: Arc<Mutex<HashMap<String, SyncBlob>>>,
    /// blob_id -> owning session_id (tenant/device scoping for sync).
    pub blob_owners: Arc<Mutex<HashMap<String, String>>>,
    /// Per-device sync cursors (device_id -> last seen epoch).
    pub device_cursors: Arc<Mutex<HashMap<String, u64>>>,
    /// Shared secret for human/operator mutations (approve, claim complete, admin).
    pub operator_token: String,
    /// Distributed task authority readiness (ADR 0031).
    pub distributed_task_authority: bool,
    /// In-memory task access engine (immutable ceiling + frozen intents).
    pub task_engine: SharedTaskEngine,
    /// task_run_id -> caller subject that started it. Authentication says a
    /// caller is known; this says which tasks are theirs, so one session cannot
    /// read or terminate another's work on a shared gateway.
    pub task_owners: Arc<Mutex<HashMap<String, String>>>,
    /// receipt_id -> caller subject that produced it. A receipt names an
    /// operation, a resource and a result summary, so it is not another
    /// session's to read.
    pub receipt_owners: Arc<Mutex<HashMap<String, String>>>,
}

impl AppState {
    pub fn demo_bootstrap_active(&self) -> bool {
        self.bootstrap.lock().unwrap().is_some()
    }

    pub fn production_bootstrap_misconfigured(&self) -> bool {
        config::is_production_env()
            && (config::dev_bootstrap_enabled() || self.demo_bootstrap_active())
    }
}

pub async fn build(args: Args) -> anyhow::Result<AppState> {
    if config::is_production_env() && config::dev_bootstrap_enabled() {
        anyhow::bail!(
            "OPENSESAME_DEV_BOOTSTRAP must not be enabled when OPENSESAME_ENV or NODE_ENV is production"
        );
    }

    catalog::load_external_registries_from_env().await;
    let turso_url = std::env::var("OPENSESAME_TURSO_URL").ok();
    let turso_token = std::env::var("OPENSESAME_TURSO_AUTH_TOKEN").ok();
    let db = Db::connect_turso(
        &args.database_url,
        turso_url.as_deref(),
        turso_token.as_deref(),
    )
    .await?;

    let boot = bootstrap::maybe_demo_bootstrap(&db).await?;
    let openfga = OpenFgaClient::from_env().ok().flatten();
    let openbao = OpenBaoHttpAuthority::from_env().ok().flatten();
    let distributed_task_authority =
        resolve_distributed_task_authority(&args.task_database_url).await;
    let connection_organization = boot
        .demo
        .as_ref()
        .map(|b| b.org)
        .unwrap_or_else(|| OrganizationId::from_uuid(uuid::Uuid::nil()));
    let connection_broker = Arc::new(ConnectionBroker::new(db.clone(), BrokerConfig::from_env()));

    Ok(AppState {
        resource: args.resource,
        issuer: args.issuer,
        db,
        broker: Arc::new(boot.broker),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        device_codes: Arc::new(Mutex::new(HashMap::new())),
        claims: Arc::new(Mutex::new(HashMap::new())),
        bootstrap: Arc::new(Mutex::new(boot.demo)),
        openfga,
        openbao,
        connection_ref: boot.connection_ref,
        connection_broker,
        connection_organization,
        sync_blobs: Arc::new(Mutex::new(HashMap::new())),
        blob_owners: Arc::new(Mutex::new(HashMap::new())),
        device_cursors: Arc::new(Mutex::new(HashMap::new())),
        operator_token: config::resolve_operator_token(),
        distributed_task_authority,
        task_engine: new_task_engine(),
        task_owners: Arc::new(Mutex::new(HashMap::new())),
        receipt_owners: Arc::new(Mutex::new(HashMap::new())),
    })
}

async fn resolve_distributed_task_authority(task_database_url: &str) -> bool {
    if !is_postgres_database_url(task_database_url) {
        return false;
    }
    match PostgresTaskStore::connect(task_database_url).await {
        Ok(store) => distributed_task_authority_ok(store.authority_backend()),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "OPENSESAME_TASK_DB postgres connect/migrate failed; distributed_task_authority=false"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use opensesame_task_access::{task_authority_backend_from_url, TaskAuthorityBackend};

    #[test]
    fn non_postgres_task_db_is_not_distributed() {
        assert_eq!(
            task_authority_backend_from_url("sqlite::memory:"),
            TaskAuthorityBackend::SqliteLocal
        );
    }
}
