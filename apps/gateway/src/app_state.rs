use crate::bootstrap;
use crate::config::{self, Args};
use crate::task_engine::{new_task_engine, SharedTaskEngine};
use opensesame_broker::Broker;
use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
use opensesame_domain::{
    ActorId, ClaimSession, ConnectionId, ConnectionRef, FrozenIntentV2, Grant, OrganizationId,
    OrganizationRole, PrincipalId, ProjectId,
};
use opensesame_provider_openbao::OpenBaoHttpAuthority;
use opensesame_provider_openfga::OpenFgaClient;
use opensesame_storage::Db;
use opensesame_task_access::{
    distributed_task_authority_ok, is_postgres_database_url, PostgresTaskStore,
};
use opensesame_task_bus::TaskBus;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct GithubAppPending {
    pub organization_id: OrganizationId,
    pub created_by: String,
    pub return_to: String,
    pub expires_at: std::time::Instant,
}

#[derive(Clone)]
pub struct DevicePending {
    /// `hash_secret(user_code)` — the low-entropy code is never held in cleartext.
    pub user_code_hash: String,
    pub client_id: String,
    pub scope: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub approved: Option<ApprovedDevice>,
}

#[derive(Clone)]
pub struct ApprovedDevice {
    pub principal: String,
    pub organization_id: OrganizationId,
    pub organization_role: OrganizationRole,
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
    /// Pending GitHub App Manifest handshakes (state → org + `return_to`).
    pub github_app_pending: Arc<Mutex<HashMap<String, GithubAppPending>>>,
    /// Serializes device-token minting with principal/org session revocation.
    pub session_lifecycle: Arc<Mutex<()>>,
    /// Timestamps of failed `user_code` approval guesses (global cooldown fence).
    pub device_approve_failures: Arc<Mutex<Vec<chrono::DateTime<chrono::Utc>>>>,
    pub claims: Arc<Mutex<HashMap<String, ClaimSession>>>,
    /// `claim_id` -> failed user-code attempts on completion (brute-force fence).
    pub claim_user_code_attempts: Arc<Mutex<HashMap<String, u32>>>,
    pub bootstrap: Arc<Mutex<Option<Bootstrap>>>,
    pub openfga: Option<OpenFgaClient>,
    pub openbao: Option<OpenBaoHttpAuthority>,
    pub connection_ref: Option<ConnectionRef>,
    /// Third-party service authorizations (ADR 0032).
    pub connection_broker: Arc<ConnectionBroker>,
    /// Relay holder liveness: subject -> last heartbeat. Process-local on
    /// purpose — a restart forgets everyone, and an unknown holder is
    /// *offline*, which is the fail-closed direction (ADR 0046 decision 5).
    pub relay_presence: Arc<Mutex<std::collections::HashMap<String, std::time::Instant>>>,
    /// Development-only process-local CA when no sealing key is configured.
    /// Production and persisted CAs never use this fallback.
    pub ephemeral_certificate_ca: Arc<Mutex<Option<crate::dev_pki::DevCa>>>,
    /// Organization connections are created under until caller metadata carries
    /// the organization directly.
    pub connection_organization: OrganizationId,
    /// Shared secret for human/operator mutations (approve, claim complete, admin).
    pub operator_token: String,
    /// Pepper for low-entropy (user code) digests.
    pub claim_pepper: String,
    /// Distributed task authority readiness (ADR 0031).
    pub distributed_task_authority: bool,
    /// In-memory task access engine (immutable ceiling + frozen intents).
    pub task_engine: SharedTaskEngine,
    /// `intent_digest` -> frozen intent awaiting execution. Server-side custody is
    /// what makes the digest enforceable: the caller cannot restate the frozen
    /// bytes, so it cannot execute anything other than what it froze.
    pub frozen_intents: Arc<Mutex<HashMap<String, FrozenIntentV2>>>,
    /// Public keys trusted to have signed a receipt, including retired ones, so a
    /// key rotation does not strand the receipts the old key signed.
    pub receipt_verifier: Arc<opensesame_audit::ReceiptVerifier>,
    /// Wakes the backup actor immediately after configuration changes or
    /// resync requests; the actor's tick covers ordinary mutations (ADR 0039).
    pub backup_notify: Arc<tokio::sync::Notify>,
    /// Wakes the sync-on-write actor immediately after config-value mutations
    /// (`sync.config.dirty` outbox appends); its tick drains anything missed.
    pub sync_notify: Arc<tokio::sync::Notify>,
    /// Host event bus (`OPENSESAME_TASKBUS` / `NATS_URL` / stored operator config).
    pub task_bus: Arc<RwLock<Arc<dyn TaskBus>>>,
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

    let db = if args.database_url == "sqlite::memory:" {
        Db::connect_memory().await?
    } else {
        Db::connect_sqlite(&args.database_url).await?
    };

    let mut boot = bootstrap::maybe_demo_bootstrap(&db).await?;
    let receipt_verifier =
        config::resolve_receipt_verifier(&boot.broker.signer).map_err(anyhow::Error::msg)?;
    let openfga = OpenFgaClient::from_env().ok().flatten();
    let openbao = OpenBaoHttpAuthority::from_env().ok().flatten();
    let distributed_task_authority =
        resolve_distributed_task_authority(&args.task_database_url).await;
    let connection_organization = boot
        .demo
        .as_ref()
        .map_or_else(|| OrganizationId::from_uuid(uuid::Uuid::nil()), |b| b.org);
    let connection_broker = Arc::new(ConnectionBroker::new(
        db.pool().clone(),
        BrokerConfig::from_env()?,
    )?);
    // Community Wasm connectors (ADR 0065 §5): loaded only when the operator
    // configured a directory + pinned digests; any failure refuses boot.
    crate::connector_egress::load_wasm_connectors(
        &mut boot.broker.host,
        &connection_broker,
        connection_organization,
    )?;
    let resolved = crate::taskbus_config::resolve(&db).await?;
    let task_bus = match crate::taskbus_config::build_bus(&resolved).await {
        Ok(bus) => bus,
        Err(error) => {
            tracing::warn!(
                %error,
                "TaskBus connect failed at boot — falling back to in-memory"
            );
            Arc::new(opensesame_task_bus::InMemoryTaskBus::default())
        }
    };

    Ok(AppState {
        resource: args.resource,
        issuer: args.issuer,
        db,
        broker: Arc::new(boot.broker),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        device_codes: Arc::new(Mutex::new(HashMap::new())),
        github_app_pending: Arc::new(Mutex::new(HashMap::new())),
        session_lifecycle: Arc::new(Mutex::new(())),
        device_approve_failures: Arc::new(Mutex::new(Vec::new())),
        claims: Arc::new(Mutex::new(HashMap::new())),
        claim_user_code_attempts: Arc::new(Mutex::new(HashMap::new())),
        bootstrap: Arc::new(Mutex::new(boot.demo)),
        openfga,
        openbao,
        connection_ref: boot.connection_ref,
        connection_broker,
        relay_presence: Arc::new(Mutex::new(std::collections::HashMap::new())),
        ephemeral_certificate_ca: Arc::new(Mutex::new(None)),
        connection_organization,
        operator_token: config::resolve_operator_token(),
        claim_pepper: config::resolve_claim_pepper(),
        distributed_task_authority,
        task_engine: new_task_engine(),
        frozen_intents: Arc::new(Mutex::new(HashMap::new())),
        receipt_verifier: Arc::new(receipt_verifier),
        backup_notify: Arc::new(tokio::sync::Notify::new()),
        sync_notify: Arc::new(tokio::sync::Notify::new()),
        task_bus: Arc::new(RwLock::new(task_bus)),
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
pub mod test_env {
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    /// Serialize tests that mutate process env (`OPENSESAME_*`, `NATS_URL`, …).
    pub fn lock() -> std::sync::MutexGuard<'static, ()> {
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
pub async fn test_demo_state() -> AppState {
    let _guard = test_env::lock();
    // Force memory bus before `build` so ambient NATS_URL cannot open sockets.
    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    let mut state = build(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.test".into(),
        issuer: "https://identity.test".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let artifacts =
        bootstrap::create_demo_bootstrap(&state.db, opensesame_audit::ReceiptSigner::generate())
            .await
            .unwrap();
    state.receipt_verifier =
        Arc::new(config::resolve_receipt_verifier(&artifacts.broker.signer).unwrap());
    state.broker = Arc::new(artifacts.broker);
    state.bootstrap = Arc::new(Mutex::new(artifacts.demo));
    state.connection_ref = artifacts.connection_ref;
    state.task_bus = Arc::new(RwLock::new(Arc::new(
        opensesame_task_bus::InMemoryTaskBus::default(),
    )));
    state
}

#[cfg(test)]
pub fn test_session_headers(
    state: &AppState,
    subject: &str,
    organization_id: OrganizationId,
    organization_role: OrganizationRole,
) -> axum::http::HeaderMap {
    let token = uuid::Uuid::new_v4().to_string();
    state.sessions.lock().unwrap().insert(
        opensesame_claims::hash_secret(&token),
        serde_json::json!({
            "principal_id": subject,
            "approved_as": subject,
            "organization_id": organization_id.to_string(),
            "organization_role": organization_role,
            "expires_at": (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
        }),
    );
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        format!("Bearer opaque-session:{token}").parse().unwrap(),
    );
    headers
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
