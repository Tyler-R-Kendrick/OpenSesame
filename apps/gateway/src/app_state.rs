use crate::bootstrap;
use crate::config::{self, Args};
use crate::task_engine::{new_task_engine, SharedTaskEngine};
use opensesame_broker::Broker;
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
    /// Timestamps of failed `user_code` approval guesses (global cooldown fence).
    pub device_approve_failures: Arc<Mutex<Vec<chrono::DateTime<chrono::Utc>>>>,
    pub claims: Arc<Mutex<HashMap<String, ClaimSession>>>,
    /// claim_id -> failed user-code attempts on completion (brute-force fence).
    pub claim_user_code_attempts: Arc<Mutex<HashMap<String, u32>>>,
    pub bootstrap: Arc<Mutex<Option<Bootstrap>>>,
    pub openfga: Option<OpenFgaClient>,
    pub openbao: Option<OpenBaoHttpAuthority>,
    pub connection_ref: Option<ConnectionRef>,
    /// Opaque ciphertext sync store — server never decrypts (ADR 0017).
    pub sync_blobs: Arc<Mutex<HashMap<String, SyncBlob>>>,
    /// blob_id -> owning session_id (tenant/device scoping for sync).
    pub blob_owners: Arc<Mutex<HashMap<String, String>>>,
    /// Per-device sync cursors (device_id -> last seen epoch).
    pub device_cursors: Arc<Mutex<HashMap<String, u64>>>,
    /// Shared secret for human/operator mutations (approve, claim complete, admin).
    pub operator_token: String,
    /// Pepper for low-entropy (user code) digests.
    pub claim_pepper: String,
    /// Distributed task authority readiness (ADR 0031).
    pub distributed_task_authority: bool,
    /// In-memory task access engine (immutable ceiling + frozen intents).
    pub task_engine: SharedTaskEngine,
    /// intent_digest -> frozen intent awaiting execution. Server-side custody is
    /// what makes the digest enforceable: the caller cannot restate the frozen
    /// bytes, so it cannot execute anything other than what it froze.
    pub frozen_intents: Arc<Mutex<HashMap<String, FrozenIntentV2>>>,
    /// Public keys trusted to have signed a receipt, including retired ones, so a
    /// key rotation does not strand the receipts the old key signed.
    pub receipt_verifier: Arc<opensesame_audit::ReceiptVerifier>,
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

    let boot = bootstrap::maybe_demo_bootstrap(&db).await?;
    let receipt_verifier =
        config::resolve_receipt_verifier(&boot.broker.signer).map_err(anyhow::Error::msg)?;
    let openfga = OpenFgaClient::from_env().ok().flatten();
    let openbao = OpenBaoHttpAuthority::from_env().ok().flatten();
    let distributed_task_authority =
        resolve_distributed_task_authority(&args.task_database_url).await;

    Ok(AppState {
        resource: args.resource,
        issuer: args.issuer,
        db,
        broker: Arc::new(boot.broker),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        device_codes: Arc::new(Mutex::new(HashMap::new())),
        device_approve_failures: Arc::new(Mutex::new(Vec::new())),
        claims: Arc::new(Mutex::new(HashMap::new())),
        claim_user_code_attempts: Arc::new(Mutex::new(HashMap::new())),
        bootstrap: Arc::new(Mutex::new(boot.demo)),
        openfga,
        openbao,
        connection_ref: boot.connection_ref,
        sync_blobs: Arc::new(Mutex::new(HashMap::new())),
        blob_owners: Arc::new(Mutex::new(HashMap::new())),
        device_cursors: Arc::new(Mutex::new(HashMap::new())),
        operator_token: config::resolve_operator_token(),
        claim_pepper: config::resolve_claim_pepper(),
        distributed_task_authority,
        task_engine: new_task_engine(),
        frozen_intents: Arc::new(Mutex::new(HashMap::new())),
        receipt_verifier: Arc::new(receipt_verifier),
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
