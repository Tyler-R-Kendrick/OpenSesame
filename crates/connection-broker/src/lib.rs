//! Connection broker: acquires third-party authorizations and holds them in the
//! authority plane (ADR 0032).
//!
//! The vault is sealed against the server by design; a connection credential is
//! deliberately the opposite, because refresh happens while the human is absent.
//! What that buys is bounded by two rules enforced here: the credential is sealed
//! under a deployment key bound to its tenant, and nothing on the API boundary
//! carries token material — callers get a [`ConnectionRef`] and status.

pub mod catalog;
pub mod changelog_hook;
pub mod config;
pub mod configuration;
pub mod crypto;
pub mod egress;
pub mod error;
pub mod flow;
pub mod github_app;
pub mod installation;
pub mod integration;
pub mod model;
pub mod rotation;
pub mod store;
pub mod sync_target;
pub mod token;

use std::collections::BTreeMap;
use std::time::Duration;

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(test)]
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use chrono::Utc;
use opensesame_domain::{
    ConnectionId, ConnectionOwnerKind, ConnectionRef, EgressBinding, OrganizationId, ProjectId,
    Shareability,
};
use rand::RngCore;
use sqlx::SqlitePool;

pub use crate::catalog::{AuthMethod, Provider};
pub use crate::changelog_hook::{
    clear_secret_changelog_for_tests, list_secret_changelog, record_secret_changelog,
    redact_changelog_metadata, ChangelogEntry, RecordSecretChangelog,
};
pub use crate::config::{BrokerConfig, ProviderConfig};
pub use crate::github_app::{
    build_manifest, convert_manifest_code, history_app_permissions, history_integration_scopes,
    is_github_app_client_id, GithubAppCredentials, GITHUB_APP_REGISTER_URL,
};
pub use crate::installation::{
    list_app_installations, mint_installation_token, GithubAppSigningMaterial,
    GithubInstallationSummary, InstallationToken, MintError, DEFAULT_GITHUB_API_BASE,
};
pub use crate::egress::GithubRepo;
pub use crate::error::{BrokerError, Result};
pub use crate::integration::{
    CreateIntegration, IntegrationSource, IntegrationView, UpdateIntegration,
};
pub use crate::model::*;
pub use crate::rotation::{
    consume_rotation_events, execute_connection_rotation, policy_due_at, request_rotation,
    RotationJob, RotationPolicy, RotationRegistry, RotationService, RotationStatus, RotationTarget,
    EVENT_ROTATION_FAILED, EVENT_ROTATION_REQUESTED, EVENT_ROTATION_SUCCEEDED,
};
pub use crate::sync_target::{
    CreateSyncTarget, EmptySecretSource, MapSecretSource, SyncOutcome, SyncSecretSource,
    SyncTargetStatus, SyncTargetView,
};

use crate::store::{AuthorizationRow, ConnectionRow, CredentialRow};
use crate::token::TokenSet;

/// A connection's ceiling is constrained HTTP inside its provider's egress
/// allowlist; materialization stays denied (ADR 0005).
const DEFAULT_MAX_INVOKE_LEVEL: u8 = 2;
/// Longest provider configuration value this will seal and store. Real keys are
/// a few hundred bytes; anything larger is a payload aimed at the shared store.
pub const MAX_CREDENTIAL_BYTES: usize = 8 * 1024;

struct TokenActivation<'a> {
    refreshed_at: Option<chrono::DateTime<Utc>>,
    account_label: Option<&'a str>,
    expected_integration_updated_at: Option<&'a str>,
    event_kind: EventKind,
    event_detail: Option<&'a str>,
    /// None captures the current local generation immediately before a local-only
    /// write. Some(None) expects no credential; Some(Some(v)) expects exactly v.
    expected_credential_version: Option<Option<&'a str>>,
}

fn require_scope_subset(requested: &[String], ceiling: &[String]) -> Result<()> {
    if let Some(scope) = requested.iter().find(|scope| !ceiling.contains(scope)) {
        return Err(BrokerError::Invalid(format!(
            "scope `{scope}` exceeds the integration scope ceiling"
        )));
    }
    Ok(())
}

fn sqlite_writer_race(error: &BrokerError) -> bool {
    matches!(
        error,
        BrokerError::Storage(sqlx::Error::Database(database))
            if matches!(database.code().as_deref(), Some("5" | "6"))
    ) || matches!(error, BrokerError::Storage(storage) if {
        let detail = storage.to_string();
        detail.contains("deadlocked") || detail.contains("database is locked")
    })
}

fn generated_connection_configuration(provider_id: &str) -> Option<BTreeMap<String, String>> {
    match provider_id {
        "plain" => Some(BTreeMap::from([("namespace".into(), "opensesame".into())])),
        "sealed-local" => {
            let mut key = [0_u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            Some(BTreeMap::from([
                ("location".into(), "opensesame://sealed-local".into()),
                (
                    "key".into(),
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
                ),
            ]))
        }
        _ => None,
    }
}

pub struct ConnectionBroker {
    pool: SqlitePool,
    config: BrokerConfig,
    http: reqwest::Client,
    activation_lock: tokio::sync::Mutex<()>,
    authorization_lock: tokio::sync::Mutex<()>,
    discovery_lock: tokio::sync::Mutex<()>,
    discovery_organization: tokio::sync::Mutex<Option<String>>,
    #[cfg(test)]
    activation_pause: Mutex<Option<Arc<TestActivationPause>>>,
    #[cfg(test)]
    refresh_pause: Mutex<Option<Arc<TestActivationPause>>>,
    #[cfg(test)]
    cleanup_attempts: Mutex<Vec<String>>,
}

#[cfg(test)]
pub(crate) struct TestActivationPause {
    target: usize,
    reached_count: AtomicUsize,
    reached: tokio::sync::Notify,
    resume: tokio::sync::Semaphore,
}

#[cfg(test)]
impl TestActivationPause {
    pub(crate) fn new() -> Arc<Self> {
        Self::for_responses(1)
    }

    pub(crate) fn for_responses(target: usize) -> Arc<Self> {
        Arc::new(Self {
            target,
            reached_count: AtomicUsize::new(0),
            reached: tokio::sync::Notify::new(),
            resume: tokio::sync::Semaphore::new(0),
        })
    }

    pub(crate) async fn wait_until_reached(&self) {
        self.reached.notified().await;
    }

    pub(crate) fn resume(&self) {
        self.resume.add_permits(self.target);
    }
}

impl ConnectionBroker {
    pub fn new(pool: SqlitePool, config: BrokerConfig) -> Result<Self> {
        catalog::load()?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Ok(Self {
            pool,
            config,
            http,
            activation_lock: tokio::sync::Mutex::new(()),
            authorization_lock: tokio::sync::Mutex::new(()),
            discovery_lock: tokio::sync::Mutex::new(()),
            discovery_organization: tokio::sync::Mutex::new(None),
            #[cfg(test)]
            activation_pause: Mutex::new(None),
            #[cfg(test)]
            refresh_pause: Mutex::new(None),
            #[cfg(test)]
            cleanup_attempts: Mutex::new(Vec::new()),
        })
    }

    #[cfg(test)]
    fn pause_next_activation(&self, pause: Arc<TestActivationPause>) {
        *self.activation_pause.lock().expect("activation pause lock") = Some(pause);
    }

    #[cfg(test)]
    fn pause_next_refreshes(&self, pause: Arc<TestActivationPause>) {
        *self.refresh_pause.lock().expect("refresh pause lock") = Some(pause);
    }

    #[cfg(test)]
    async fn pause_after_token_response(&self) {
        let pause = self
            .activation_pause
            .lock()
            .expect("activation pause lock")
            .clone();
        if let Some(pause) = pause {
            if pause.reached_count.fetch_add(1, Ordering::SeqCst) + 1 == pause.target {
                pause.reached.notify_one();
            }
            let permit = pause.resume.acquire().await.expect("activation resume");
            permit.forget();
        }
    }

    #[cfg(test)]
    async fn pause_after_refresh_read(&self) {
        let pause = self
            .refresh_pause
            .lock()
            .expect("refresh pause lock")
            .clone();
        if let Some(pause) = pause {
            if pause.reached_count.fetch_add(1, Ordering::SeqCst) + 1 == pause.target {
                pause.reached.notify_one();
            }
            let permit = pause.resume.acquire().await.expect("refresh resume");
            permit.forget();
        }
    }

    #[cfg(test)]
    fn take_cleanup_attempts(&self) -> Vec<String> {
        std::mem::take(&mut *self.cleanup_attempts.lock().expect("cleanup lock"))
    }

    pub fn config(&self) -> &BrokerConfig {
        &self.config
    }

    pub fn http_client(&self) -> &reqwest::Client {
        &self.http
    }

    // ---- catalog -------------------------------------------------------------

    pub fn list_providers(&self) -> Result<Vec<ProviderView>> {
        let catalog_revision = catalog::revision()?;
        Ok(catalog::all()?
            .iter()
            .filter(|p| !flow::is_production_env() || p.id != "mock")
            .map(|p| {
                let missing = self.config.missing_config(p);
                ProviderView::new(
                    p,
                    missing.is_empty(),
                    self.automatic_connection_configuration(&p.id).is_some(),
                    missing,
                    p.auth.is_oauth().then(|| self.config.callback_url(&p.id)),
                    catalog_revision,
                )
            })
            .collect())
    }

    fn provider(&self, id: &str) -> Result<&'static Provider> {
        if id == "mock" && flow::is_production_env() {
            return Err(BrokerError::ProviderUnknown(id.to_string()));
        }
        catalog::find(id)?.ok_or_else(|| BrokerError::ProviderUnknown(id.to_string()))
    }

    fn automatic_connection_configuration(
        &self,
        provider_id: &str,
    ) -> Option<BTreeMap<String, String>> {
        self.config
            .detected_connection(provider_id)
            .or_else(|| generated_connection_configuration(provider_id))
    }

    fn sealing_key(&self) -> Result<&[u8; 32]> {
        self.config.key().ok_or_else(|| {
            BrokerError::SealUnavailable(format!("{} is not set", config::ENV_CONNECTION_KEY))
        })
    }

    // ---- connections ---------------------------------------------------------

    /// Ambient Host credentials belong to one tenant. The first eligible local
    /// organization claims them; production callers are already operator-only.
    pub async fn claim_discovery_organization(&self, organization_id: &OrganizationId) -> bool {
        let selected = organization_id.to_string();
        let mut claimed = self.discovery_organization.lock().await;
        match claimed.as_ref() {
            Some(existing) => existing == &selected,
            None => {
                *claimed = Some(selected);
                true
            }
        }
    }

    /// Import complete credentials already present in the Host environment.
    /// Values cross only from ambient Host configuration into the sealed store;
    /// callers receive the ordinary redacted connection view.
    pub async fn auto_configure_connections(
        &self,
        organization_id: &OrganizationId,
        owner_subject: Option<&str>,
    ) -> usize {
        if self.config.key().is_none() {
            return 0;
        }
        let _guard = self.discovery_lock.lock().await;
        let Ok(mut rows) = store::list_connections(&self.pool, &organization_id.to_string()).await
        else {
            return 0;
        };
        let mut configured = 0;
        let Ok(providers) = catalog::all() else {
            return 0;
        };
        for provider in providers {
            if rows.iter().any(|row| {
                row.provider_id == provider.id && row.owner_subject.as_deref() == owner_subject
            }) {
                continue;
            }
            if self
                .automatic_connection_configuration(&provider.id)
                .is_none()
            {
                continue;
            }
            if !matches!(
                provider.auth,
                AuthMethod::ApiKey { .. } | AuthMethod::Configuration
            ) && !accepts_pasted_access_token(&provider.id)
            {
                continue;
            }
            let created = match self
                .create_connection(
                    organization_id,
                    CreateConnection {
                        provider_id: provider.id.clone(),
                        integration_id: None,
                        owner_subject: owner_subject.map(str::to_string),
                        display_name: Some(provider.display_name.clone()),
                        logical_name: None,
                        project_id: None,
                        scopes: None,
                        shareability: None,
                    },
                )
                .await
            {
                Ok(created) => created,
                Err(error) => {
                    tracing::warn!(provider_id = provider.id, %error, "detected connection import failed");
                    continue;
                }
            };
            configured += 1;
            if let Ok(Some(row)) = store::get_connection(&self.pool, &created.connection_id).await {
                rows.push(row);
            }
            tracing::info!(
                provider_id = provider.id,
                "detected Host connection configured"
            );
        }
        configured
    }

    pub async fn create_connection(
        &self,
        organization_id: &OrganizationId,
        request: CreateConnection,
    ) -> Result<ConnectionView> {
        let requested_provider = request.provider_id.trim();
        if !requested_provider.is_empty() {
            self.provider(requested_provider)?;
        }
        let (integration_id, provider_id, _provider_config, integration_scopes, _) = self
            .resolve_integration(
                organization_id,
                (!requested_provider.is_empty()).then_some(requested_provider),
                request.integration_id.as_deref(),
            )
            .await?;
        let provider = self.provider(&provider_id)?;
        let automatic_configuration = self.automatic_connection_configuration(&provider.id);
        if let Some(configuration) = automatic_configuration.as_ref() {
            if !(accepts_pasted_access_token(&provider.id)
                && configuration.contains_key("access_token"))
            {
                let definitions = provider.connection_configuration_fields();
                configuration::validate_mutation(definitions, configuration, &[])?;
                if !configuration::complete(definitions, configuration) {
                    return Err(BrokerError::Invalid(format!(
                        "detected {} configuration is incomplete",
                        provider.id
                    )));
                }
            }
            self.sealing_key()?;
        }
        if let Some(scopes) = request.scopes.as_ref() {
            require_scope_subset(scopes, &integration_scopes)?;
        }
        let organization = organization_id.to_string();

        let logical_name = match request.logical_name.filter(|n| !n.trim().is_empty()) {
            Some(name) => {
                let name = name.trim().to_string();
                if store::logical_name_taken(&self.pool, &organization, &name).await? {
                    return Err(BrokerError::Invalid(format!(
                        "logical_name `{name}` is already used in this organization"
                    )));
                }
                name
            }
            None => {
                self.unused_logical_name(&organization, &provider.id)
                    .await?
            }
        };

        let now = Utc::now();
        let row = ConnectionRow {
            id: opensesame_domain::ConnectionId::new().to_string(),
            organization_id: organization,
            project_id: request.project_id.filter(|p| !p.is_empty()),
            provider_id: provider.id.to_string(),
            integration_id,
            display_name: request
                .display_name
                .filter(|d| !d.trim().is_empty())
                .unwrap_or_else(|| provider.display_name.to_string()),
            logical_name,
            status: ConnectionStatus::Pending,
            status_detail: None,
            requested_scopes: request
                .scopes
                .filter(|s| !s.is_empty())
                .unwrap_or(integration_scopes),
            granted_scopes: Vec::new(),
            account_label: None,
            owner_kind: owner_kind_str(ConnectionOwnerKind::Organization).to_string(),
            owner_subject: request.owner_subject.filter(|s| !s.trim().is_empty()),
            shareability: shareability_str(request.shareability.unwrap_or(Shareability::Private))
                .to_string(),
            max_invoke_level: DEFAULT_MAX_INVOKE_LEVEL,
            egress: provider.egress.binding(),
            created_at: now,
            updated_at: now,
        };

        if let Err(error) = store::insert_connection(&self.pool, &row).await {
            if error.to_string().contains("integration_not_found") {
                return Err(BrokerError::IntegrationNotFound);
            }
            return Err(error);
        }
        store::append_event(&self.pool, &row.id, EventKind::Created, Some(&provider.id)).await?;
        tracing::info!(connection_id = %row.id, provider_id = provider.id, "connection created");
        if let Some(configuration) = automatic_configuration {
            if accepts_pasted_access_token(&provider.id) {
                if let Some(token) = configuration
                    .get("access_token")
                    .or_else(|| configuration.get("api_key"))
                    .cloned()
                {
                    return match self
                        .set_access_token(organization_id, &row.id, &token)
                        .await
                    {
                        Ok(view) => Ok(view),
                        Err(error) => {
                            let _ = store::delete_connection(&self.pool, &row.id).await;
                            Err(error)
                        }
                    };
                }
            }
            return match self
                .set_connection_configuration(organization_id, &row.id, configuration, Vec::new())
                .await
            {
                Ok(view) => Ok(view),
                Err(error) => {
                    let _ = store::delete_connection(&self.pool, &row.id).await;
                    Err(error)
                }
            };
        }
        self.view(row).await
    }

    /// `github/main`, then `github/main-2`, and so on. Two connections to the same
    /// provider is normal (personal and shared accounts); colliding names are not.
    async fn unused_logical_name(&self, organization: &str, provider_id: &str) -> Result<String> {
        let base = format!("{provider_id}/main");
        if !store::logical_name_taken(&self.pool, organization, &base).await? {
            return Ok(base);
        }
        for n in 2..1000u32 {
            let candidate = format!("{base}-{n}");
            if !store::logical_name_taken(&self.pool, organization, &candidate).await? {
                return Ok(candidate);
            }
        }
        Err(BrokerError::Invalid(
            "too many connections to this provider; pass an explicit logical_name".into(),
        ))
    }

    pub async fn list_connections(
        &self,
        organization_id: &OrganizationId,
    ) -> Result<Vec<ConnectionView>> {
        self.list_connections_for(organization_id, None).await
    }

    /// Connections in this organization, narrowed to one owner when given. An
    /// organization is not a tenancy boundary here — the gateway serves many
    /// callers out of one — so listing has to be able to answer for a single one.
    pub async fn list_connections_for(
        &self,
        organization_id: &OrganizationId,
        owner: Option<&str>,
    ) -> Result<Vec<ConnectionView>> {
        let rows = store::list_connections(&self.pool, &organization_id.to_string()).await?;
        let mut views = Vec::with_capacity(rows.len());
        for row in rows {
            if let Some(owner) = owner {
                if row.owner_subject.as_deref() != Some(owner) {
                    continue;
                }
            }
            views.push(self.view(row).await?);
        }
        Ok(views)
    }

    /// Who this connection was created for, if anyone. `None` covers rows made
    /// before owners were recorded and those an operator made on nobody's behalf:
    /// both stay operator-only rather than becoming everybody's.
    pub async fn owner_subject(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<Option<String>> {
        Ok(self.row_in_org(organization_id, id).await?.owner_subject)
    }

    pub async fn get_connection(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<ConnectionView> {
        let row = self.row_in_org(organization_id, id).await?;
        self.view(row).await
    }

    pub async fn events(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<Vec<EventView>> {
        self.row_in_org(organization_id, id).await?;
        store::list_events(&self.pool, id).await
    }

    /// A connection in another organization reads as absent rather than forbidden,
    /// so ids cannot be probed for existence.
    async fn row_in_org(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<ConnectionRow> {
        let row = store::get_connection(&self.pool, id)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
        if row.organization_id != organization_id.to_string() {
            return Err(BrokerError::ConnectionNotFound);
        }
        Ok(row)
    }

    // ---- authorization -------------------------------------------------------

    pub async fn start_authorization(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        redirect_uri: Option<String>,
        scopes: Option<Vec<String>>,
    ) -> Result<AuthorizationStart> {
        let mut row = self.row_in_org(organization_id, id).await?;
        if row.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid(
                "connection is revoked; create a new one".into(),
            ));
        }
        let provider = self.provider(&row.provider_id)?;
        let (integration_id, _, provider_config, integration_scopes, _) = self
            .resolve_integration(
                organization_id,
                Some(&provider.id),
                (!row.integration_id.is_empty()).then_some(row.integration_id.as_str()),
            )
            .await?;
        if row.integration_id != integration_id {
            store::set_integration_id(&self.pool, &row.id, &integration_id).await?;
            row.integration_id = integration_id;
        }
        let config = self
            .config
            .clone()
            .with_provider(&provider.id, provider_config);
        if !provider.auth.is_oauth() {
            return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
        }
        let missing = config.missing_config(provider);
        if !missing.is_empty() {
            return Err(BrokerError::ProviderUnconfigured {
                provider: provider.id.to_string(),
                missing,
            });
        }
        // Refuse before sending a human to a consent screen whose result we could
        // not store.
        self.sealing_key()?;

        let redirect_uri = match redirect_uri.filter(|r| !r.trim().is_empty()) {
            Some(uri) => {
                if !self.config.redirect_allowed(&provider.id, uri.trim()) {
                    return Err(BrokerError::RedirectNotAllowed);
                }
                uri.trim().to_string()
            }
            None => self.config.callback_url(&provider.id),
        };

        let scope_override = scopes.filter(|scopes| !scopes.is_empty());
        let scopes = scope_override
            .clone()
            .unwrap_or_else(|| row.requested_scopes.clone());
        require_scope_subset(&scopes, &integration_scopes)?;
        if scope_override.is_some() {
            store::set_requested_scopes(&self.pool, &row.id, &scopes).await?;
        }

        let pkce = flow::Pkce::generate();
        let state = flow::new_state();
        let expires_at = Utc::now() + chrono::Duration::seconds(flow::STATE_TTL_SECONDS);
        let client_id = config.provider(&provider.id).client_id.unwrap_or_default();
        // GitHub Apps: classic `scope=` values (e.g. `repo`) do not grant
        // repository Administration. Omitting scope authorizes every permission
        // configured on the App (including administration:write for POST /user/repos).
        let authorize_scopes: &[String] =
            if provider.id == "github" && is_github_app_client_id(&client_id) {
                &[]
            } else {
                &scopes
            };
        let authorization_url = flow::build_authorize_url(
            provider,
            &config,
            flow::AuthorizeParams {
                client_id: &client_id,
                redirect_uri: &redirect_uri,
                scopes: authorize_scopes,
                state: &state,
                code_challenge: &pkce.challenge,
            },
        )?;

        store::insert_authorization(
            &self.pool,
            &AuthorizationRow {
                state: state.clone(),
                connection_id: row.id.clone(),
                code_verifier: crypto::seal(
                    self.sealing_key()?,
                    &row.id,
                    &row.organization_id,
                    pkce.verifier.as_bytes(),
                )?,
                redirect_uri,
                scopes,
                expires_at,
                credential_version: store::get_credential(&self.pool, &row.id)
                    .await?
                    .map(|credential| credential.version),
            },
        )
        .await?;
        store::append_event(
            &self.pool,
            &row.id,
            EventKind::AuthorizeStarted,
            Some(&provider.id),
        )
        .await?;
        tracing::info!(connection_id = %row.id, provider_id = provider.id, "authorization started");

        Ok(AuthorizationStart {
            authorization_url,
            state,
            expires_at: expires_at.to_rfc3339(),
        })
    }

    pub async fn complete_authorization(
        &self,
        provider_id: &str,
        code: &str,
        state: &str,
    ) -> Result<ConnectionView> {
        let authorization = {
            let _claim_guard = self.authorization_lock.lock().await;
            store::consume_authorization(&self.pool, state, Utc::now()).await?
        };
        let row = store::get_connection(&self.pool, &authorization.connection_id)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
        if row.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid("connection is revoked".into()));
        }
        // A state belongs to one connection and therefore to one provider; a
        // callback arriving on another provider's path is not this state's.
        if row.provider_id != provider_id {
            return Err(BrokerError::InvalidState);
        }
        let provider = self.provider(&row.provider_id)?;
        let organization_id = OrganizationId::parse(&row.organization_id)
            .map_err(|_| BrokerError::Invalid("stored organization_id is invalid".into()))?;
        let (_, _, provider_config, initial_ceiling, expected_integration_updated_at) = self
            .resolve_integration(
                &organization_id,
                Some(&provider.id),
                (!row.integration_id.is_empty()).then_some(row.integration_id.as_str()),
            )
            .await?;
        require_scope_subset(&authorization.scopes, &initial_ceiling)?;
        let config = self
            .config
            .clone()
            .with_provider(&provider.id, provider_config);
        let key = *self.sealing_key()?;
        let code_verifier = String::from_utf8(crypto::open(
            &key,
            &row.id,
            &row.organization_id,
            &authorization.code_verifier,
        )?)
        .map_err(|_| BrokerError::SealUnavailable("PKCE verifier is not UTF-8".into()))?;

        let response = match flow::exchange_code(
            &self.http,
            provider,
            &config,
            code,
            &code_verifier,
            &authorization.redirect_uri,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                let detail = e.hint();
                if !store::transition_unless_revoked(
                    &self.pool,
                    &row.id,
                    ConnectionStatus::Error,
                    Some(&detail),
                    EventKind::Error,
                    Some(&detail),
                )
                .await?
                {
                    return Err(BrokerError::Invalid("connection is revoked".into()));
                }
                tracing::warn!(connection_id = %row.id, provider_id = provider.id, "token exchange failed");
                return Err(e);
            }
        };

        let account_label = response.account_label();
        let tokens = match response.into_token_set(Utc::now(), &authorization.scopes) {
            Ok(tokens) => tokens,
            Err(error) => {
                let issued = response.issued_tokens_for_cleanup(&authorization.scopes);
                self.revoke_issued_tokens(provider, &config, &issued).await;
                let detail = error.hint();
                let _ = store::invalidate_credential_unless_revoked(
                    &self.pool,
                    &row.id,
                    ConnectionStatus::Error,
                    &detail,
                    EventKind::Error,
                )
                .await?;
                return Err(error);
            }
        };
        #[cfg(test)]
        self.pause_after_token_response().await;
        let current_integration = match self
            .get_integration(&organization_id, &row.integration_id)
            .await
        {
            Ok(integration)
                if integration.enabled
                    && integration.configured
                    && expected_integration_updated_at
                        .as_ref()
                        .is_none_or(|expected| integration.updated_at == *expected) =>
            {
                integration
            }
            _ => {
                self.revoke_issued_tokens(provider, &config, &tokens).await;
                let detail = "integration changed while authorization was in flight";
                let _ = store::invalidate_credential_unless_revoked(
                    &self.pool,
                    &row.id,
                    ConnectionStatus::Error,
                    detail,
                    EventKind::Error,
                )
                .await?;
                return Err(BrokerError::IntegrationConflict);
            }
        };
        let current_ceiling = current_integration.scopes;
        if let Err(error) = require_scope_subset(&authorization.scopes, &current_ceiling)
            .and_then(|()| require_scope_subset(&tokens.scopes, &current_ceiling))
        {
            self.revoke_issued_tokens(provider, &config, &tokens).await;
            let detail = error.hint();
            let _ = store::invalidate_credential_unless_revoked(
                &self.pool,
                &row.id,
                ConnectionStatus::Error,
                &detail,
                EventKind::Error,
            )
            .await?;
            return Err(error);
        }
        let activated = self
            .store_tokens(
                &key,
                &row,
                &tokens,
                TokenActivation {
                    refreshed_at: None,
                    account_label: account_label.as_deref(),
                    expected_integration_updated_at: expected_integration_updated_at.as_deref(),
                    event_kind: EventKind::Authorized,
                    event_detail: Some(&provider.id),
                    expected_credential_version: Some(authorization.credential_version.as_deref()),
                },
            )
            .await;
        match activated {
            Ok(store::CredentialActivationOutcome::Activated) => {}
            Ok(store::CredentialActivationOutcome::Revoked) => {
                self.revoke_issued_tokens(provider, &config, &tokens).await;
                return Err(BrokerError::Invalid("connection is revoked".into()));
            }
            Ok(store::CredentialActivationOutcome::Superseded) => {
                self.revoke_issued_tokens(provider, &config, &tokens).await;
                return self.get_connection_unscoped(&row.id).await;
            }
            Err(error) => {
                self.revoke_issued_tokens(provider, &config, &tokens).await;
                let detail = error.hint();
                let _ = store::invalidate_credential_unless_revoked(
                    &self.pool,
                    &row.id,
                    ConnectionStatus::Error,
                    &detail,
                    EventKind::Error,
                )
                .await?;
                return Err(error);
            }
        }
        tracing::info!(connection_id = %row.id, provider_id = provider.id, "connection authorized");

        self.get_connection_unscoped(&row.id).await
    }

    pub async fn reject_authorization(
        &self,
        provider_id: &str,
        state: &str,
        detail: &str,
    ) -> Result<()> {
        let authorization = {
            let _claim_guard = self.authorization_lock.lock().await;
            store::consume_authorization(&self.pool, state, Utc::now()).await?
        };
        let row = store::get_connection(&self.pool, &authorization.connection_id)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
        if row.provider_id != provider_id {
            return Err(BrokerError::InvalidState);
        }
        if row.status != ConnectionStatus::Revoked {
            let _ = store::transition_unless_revoked(
                &self.pool,
                &row.id,
                ConnectionStatus::Error,
                Some(detail),
                EventKind::Error,
                Some(detail),
            )
            .await?;
        }
        Ok(())
    }

    pub async fn refresh(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<ConnectionView> {
        let mut row = self.row_in_org(organization_id, id).await?;
        let provider = self.provider(&row.provider_id)?;
        let (integration_id, _, provider_config, initial_ceiling, expected_integration_updated_at) =
            self.resolve_integration(
                organization_id,
                Some(&provider.id),
                (!row.integration_id.is_empty()).then_some(row.integration_id.as_str()),
            )
            .await?;
        require_scope_subset(&row.requested_scopes, &initial_ceiling)?;
        if row.integration_id.is_empty() {
            store::set_integration_id(&self.pool, &row.id, &integration_id).await?;
            row.integration_id = integration_id;
        }
        let config = self
            .config
            .clone()
            .with_provider(&provider.id, provider_config);
        let key = *self.sealing_key()?;

        let credential = store::get_credential(&self.pool, &row.id)
            .await?
            .ok_or(BrokerError::NotRefreshable)?;
        let tokens = self.open_tokens(&key, &row, &credential)?;
        if !tokens.refreshable() || !provider.auth.supports_refresh() {
            return Err(BrokerError::NotRefreshable);
        }
        let missing = config.missing_config(provider);
        if !missing.is_empty() {
            return Err(BrokerError::ProviderUnconfigured {
                provider: provider.id.to_string(),
                missing,
            });
        }
        #[cfg(test)]
        self.pause_after_refresh_read().await;

        match token::refresh(&self.http, provider, &config, &tokens).await {
            Ok(response) => {
                let next = match token::apply_refresh(&tokens, response.clone(), Utc::now()) {
                    Ok(next) => next,
                    Err(error) => {
                        let issued = response.issued_tokens_for_cleanup(&row.requested_scopes);
                        self.revoke_issued_tokens(provider, &config, &issued).await;
                        let detail = error.hint();
                        let _ = store::invalidate_credential_unless_revoked(
                            &self.pool,
                            &row.id,
                            ConnectionStatus::NeedsReauth,
                            &detail,
                            EventKind::RefreshFailed,
                        )
                        .await?;
                        return Err(BrokerError::NeedsReauth(detail));
                    }
                };
                let now = Utc::now();
                #[cfg(test)]
                self.pause_after_token_response().await;
                let current_integration = match self
                    .get_integration(organization_id, &row.integration_id)
                    .await
                {
                    Ok(integration)
                        if integration.enabled
                            && integration.configured
                            && expected_integration_updated_at
                                .as_ref()
                                .is_none_or(|expected| integration.updated_at == *expected) =>
                    {
                        integration
                    }
                    _ => {
                        self.revoke_issued_tokens(provider, &config, &next).await;
                        let detail = "integration changed while refresh was in flight";
                        let _ = store::invalidate_credential_unless_revoked(
                            &self.pool,
                            &row.id,
                            ConnectionStatus::NeedsReauth,
                            detail,
                            EventKind::RefreshFailed,
                        )
                        .await?;
                        return Err(BrokerError::NeedsReauth(detail.into()));
                    }
                };
                let current_ceiling = current_integration.scopes;
                if let Err(error) = require_scope_subset(&row.requested_scopes, &current_ceiling)
                    .and_then(|()| require_scope_subset(&next.scopes, &current_ceiling))
                {
                    self.revoke_issued_tokens(provider, &config, &next).await;
                    let detail = error.hint();
                    let _ = store::invalidate_credential_unless_revoked(
                        &self.pool,
                        &row.id,
                        ConnectionStatus::NeedsReauth,
                        &detail,
                        EventKind::RefreshFailed,
                    )
                    .await?;
                    return Err(BrokerError::NeedsReauth(detail));
                }
                let activated = self
                    .store_tokens(
                        &key,
                        &row,
                        &next,
                        TokenActivation {
                            refreshed_at: Some(now),
                            account_label: None,
                            expected_integration_updated_at: expected_integration_updated_at
                                .as_deref(),
                            event_kind: EventKind::Refreshed,
                            event_detail: None,
                            expected_credential_version: Some(Some(&credential.version)),
                        },
                    )
                    .await;
                match activated {
                    Ok(store::CredentialActivationOutcome::Activated) => {}
                    Ok(store::CredentialActivationOutcome::Revoked) => {
                        self.revoke_issued_tokens(provider, &config, &next).await;
                        return Err(BrokerError::Invalid("connection is revoked".into()));
                    }
                    Ok(store::CredentialActivationOutcome::Superseded) => {
                        self.revoke_issued_tokens(provider, &config, &next).await;
                        return self.get_connection_unscoped(&row.id).await;
                    }
                    Err(error) => {
                        self.revoke_issued_tokens(provider, &config, &next).await;
                        let detail = error.hint();
                        let _ = store::invalidate_credential_unless_revoked(
                            &self.pool,
                            &row.id,
                            ConnectionStatus::NeedsReauth,
                            &detail,
                            EventKind::RefreshFailed,
                        )
                        .await?;
                        return Err(BrokerError::NeedsReauth(detail));
                    }
                }
                tracing::info!(connection_id = %row.id, provider_id = provider.id, "connection refreshed");
                self.get_connection_unscoped(&row.id).await
            }
            Err(e) => {
                // A provider that rotates refresh tokens rejects the older one, so
                // two refreshes at once means the loser is told `invalid_grant` about
                // a grant that is in fact alive. Only the tokens on record can say
                // which happened: if they have moved on, someone else refreshed and
                // this failure is not the connection's news to carry.
                if self.credential_moved_on(&key, &row, &tokens).await {
                    return self.get_connection_unscoped(&row.id).await;
                }
                // The grant is gone upstream; keep the row, its bindings and its
                // history so re-authorization is a step rather than a rebuild.
                let detail = e.hint();
                if !store::transition_unless_revoked(
                    &self.pool,
                    &row.id,
                    ConnectionStatus::NeedsReauth,
                    Some(&detail),
                    EventKind::RefreshFailed,
                    Some(&detail),
                )
                .await?
                {
                    return Err(BrokerError::Invalid("connection is revoked".into()));
                }
                tracing::warn!(connection_id = %row.id, provider_id = provider.id, "refresh rejected");
                Err(match e {
                    BrokerError::NotRefreshable => BrokerError::NotRefreshable,
                    other => BrokerError::NeedsReauth(other.hint()),
                })
            }
        }
    }

    /// Whether the stored credential is no longer the one `used` was read from —
    /// that is, whether another refresh landed while this one was in flight. A
    /// credential that cannot be read at all is not evidence of that.
    async fn credential_moved_on(
        &self,
        key: &[u8; 32],
        row: &ConnectionRow,
        used: &TokenSet,
    ) -> bool {
        let Ok(Some(current)) = store::get_credential(&self.pool, &row.id).await else {
            return false;
        };
        let Ok(current) = self.open_tokens(key, row, &current) else {
            return false;
        };
        current.access_token != used.access_token || current.refresh_token != used.refresh_token
    }

    pub async fn set_api_key(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        value: &str,
    ) -> Result<ConnectionView> {
        self.set_connection_configuration(
            organization_id,
            id,
            BTreeMap::from([("api_key".into(), value.trim().into())]),
            Vec::new(),
        )
        .await
    }

    /// Seal a pasted personal access token for providers that accept bearer
    /// tokens (GitHub / GitLab). Activates the connection without an OAuth App.
    pub async fn set_access_token(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        access_token: &str,
    ) -> Result<ConnectionView> {
        let token = access_token.trim();
        if token.is_empty() {
            return Err(BrokerError::Invalid("access token is required".into()));
        }
        if token.len() > crate::MAX_CREDENTIAL_BYTES {
            return Err(BrokerError::Invalid(format!(
                "access token exceeds {} bytes",
                crate::MAX_CREDENTIAL_BYTES
            )));
        }
        let mut row = self.row_in_org(organization_id, id).await?;
        let provider = self.provider(&row.provider_id)?;
        if !accepts_pasted_access_token(&provider.id) {
            return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
        }
        let (integration_id, _, _, _, expected_integration_updated_at) = self
            .resolve_integration(
                organization_id,
                Some(&provider.id),
                (!row.integration_id.is_empty()).then_some(row.integration_id.as_str()),
            )
            .await?;
        if row.integration_id.is_empty() {
            store::set_integration_id(&self.pool, &row.id, &integration_id).await?;
            row.integration_id = integration_id;
        }
        let account_label = self.probe_access_token_account(&provider.id, token).await?;
        let key = *self.sealing_key()?;
        let current = store::get_credential(&self.pool, &row.id).await?;
        let expected_version = current
            .as_ref()
            .map(|credential| credential.version.clone());
        let tokens = TokenSet {
            access_token: token.to_string(),
            refresh_token: None,
            token_type: "Bearer".into(),
            expires_at: None,
            scopes: row.requested_scopes.clone(),
            configuration: BTreeMap::new(),
        };
        match self
            .store_tokens(
                &key,
                &row,
                &tokens,
                TokenActivation {
                    refreshed_at: None,
                    account_label: account_label.as_deref(),
                    expected_integration_updated_at: expected_integration_updated_at.as_deref(),
                    event_kind: EventKind::Authorized,
                    event_detail: Some("personal access token sealed"),
                    expected_credential_version: Some(expected_version.as_deref()),
                },
            )
            .await?
        {
            store::CredentialActivationOutcome::Activated => {}
            store::CredentialActivationOutcome::Revoked => {
                return Err(BrokerError::Invalid("connection is revoked".into()));
            }
            store::CredentialActivationOutcome::Superseded => {
                return self.get_connection_unscoped(&row.id).await;
            }
        }
        tracing::info!(
            connection_id = %row.id,
            provider_id = provider.id,
            "access token sealed"
        );
        self.get_connection_unscoped(&row.id).await
    }

    async fn probe_access_token_account(
        &self,
        provider_id: &str,
        token: &str,
    ) -> Result<Option<String>> {
        match provider_id {
            "github" => {
                let url = format!("{}/user", self.config.github_api_base());
                let res = self
                    .http
                    .get(&url)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Accept", "application/vnd.github+json")
                    .header("User-Agent", "OpenSesame-Host/0.1")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .send()
                    .await
                    .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
                let status = res.status();
                let text = res.text().await.map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
                if !(200..300).contains(&status.as_u16()) {
                    let snippet: String = text.chars().take(160).collect();
                    return Err(BrokerError::ExchangeFailed(format!(
                        "GitHub rejected the token ({status}): {snippet}"
                    )));
                }
                let body: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
                Ok(body
                    .get("login")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()))
            }
            "gitlab" => {
                let res = self
                    .http
                    .get("https://gitlab.com/api/v4/user")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("User-Agent", "OpenSesame-Host/0.1")
                    .send()
                    .await
                    .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
                let status = res.status();
                let text = res.text().await.map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
                if !(200..300).contains(&status.as_u16()) {
                    return Err(BrokerError::ExchangeFailed(format!(
                        "GitLab rejected the token ({status})"
                    )));
                }
                let body: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| BrokerError::ExchangeFailed(e.to_string()))?;
                Ok(body
                    .get("username")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()))
            }
            _ => Ok(None),
        }
    }

    pub async fn set_connection_configuration(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        mut configuration_set: BTreeMap<String, String>,
        configuration_clear: Vec<String>,
    ) -> Result<ConnectionView> {
        let mut row = self.row_in_org(organization_id, id).await?;
        let provider = self.provider(&row.provider_id)?;
        let (integration_id, _, _, _, expected_integration_updated_at) = self
            .resolve_integration(
                organization_id,
                Some(&provider.id),
                (!row.integration_id.is_empty()).then_some(row.integration_id.as_str()),
            )
            .await?;
        if row.integration_id.is_empty() {
            store::set_integration_id(&self.pool, &row.id, &integration_id).await?;
            row.integration_id = integration_id;
        }
        if !matches!(
            &provider.auth,
            AuthMethod::ApiKey { .. } | AuthMethod::Configuration
        ) {
            return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
        }
        if let Some(value) = configuration_set.get_mut("api_key") {
            *value = value.trim().to_string();
        }
        let definitions = provider.connection_configuration_fields();
        configuration::validate_mutation(definitions, &configuration_set, &configuration_clear)?;
        let key = *self.sealing_key()?;
        let current = store::get_credential(&self.pool, &row.id).await?;
        let expected_version = current
            .as_ref()
            .map(|credential| credential.version.clone());
        let mut configuration = match current.as_ref() {
            Some(credential) => {
                let tokens = self.open_tokens(&key, &row, credential)?;
                if tokens.configuration.is_empty() && tokens.token_type == "api_key" {
                    BTreeMap::from([("api_key".into(), tokens.access_token)])
                } else {
                    tokens.configuration
                }
            }
            None => BTreeMap::new(),
        };
        configuration::apply(&mut configuration, configuration_set, &configuration_clear);
        configuration::validate_mutation(definitions, &configuration, &[])?;
        if !configuration::complete(definitions, &configuration) {
            let outcome = store::clear_credential_unless_revoked(
                &self.pool,
                &row.id,
                expected_version.as_deref(),
            )
            .await?;
            return match outcome {
                store::CredentialActivationOutcome::Activated
                | store::CredentialActivationOutcome::Superseded => {
                    self.get_connection_unscoped(&row.id).await
                }
                store::CredentialActivationOutcome::Revoked => {
                    Err(BrokerError::Invalid("connection is revoked".into()))
                }
            };
        }
        let value = configuration.get("api_key").cloned().unwrap_or_default();
        let tokens = TokenSet {
            access_token: value,
            refresh_token: None,
            token_type: provider.auth.kind().into(),
            expires_at: None,
            scopes: Vec::new(),
            configuration,
        };
        match self
            .store_tokens(
                &key,
                &row,
                &tokens,
                TokenActivation {
                    refreshed_at: None,
                    account_label: None,
                    expected_integration_updated_at: expected_integration_updated_at.as_deref(),
                    event_kind: EventKind::Authorized,
                    event_detail: Some("connection configuration stored"),
                    expected_credential_version: Some(expected_version.as_deref()),
                },
            )
            .await?
        {
            store::CredentialActivationOutcome::Activated => {}
            store::CredentialActivationOutcome::Revoked => {
                return Err(BrokerError::Invalid("connection is revoked".into()));
            }
            store::CredentialActivationOutcome::Superseded => {
                return self.get_connection_unscoped(&row.id).await;
            }
        }
        tracing::info!(connection_id = %row.id, provider_id = provider.id, "connection configuration stored");
        self.get_connection_unscoped(&row.id).await
    }

    pub async fn revoke(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<RevokeOutcome> {
        let row = self.row_in_org(organization_id, id).await?;
        let provider = self.provider(&row.provider_id).ok();
        let config = match provider {
            Some(provider) => {
                let provider_config = if row.integration_id.is_empty() {
                    self.resolve_integration(organization_id, Some(&provider.id), None)
                        .await
                        .ok()
                        .map(|(_, _, config, _, _)| config)
                } else {
                    self.pinned_provider_config(organization_id, &provider.id, &row.integration_id)
                        .await
                        .ok()
                };
                provider_config.map(|provider_config| {
                    self.config
                        .clone()
                        .with_provider(&provider.id, provider_config)
                })
            }
            None => None,
        };
        let token_set = match (
            self.config.key(),
            store::get_credential(&self.pool, &row.id).await?,
        ) {
            (Some(key), Some(credential)) => self.open_tokens(key, &row, &credential).ok(),
            _ => None,
        };
        store::revoke_local(&self.pool, &row.id).await?;
        store::append_event(&self.pool, &row.id, EventKind::Revoked, None).await?;
        tracing::info!(connection_id = %row.id, provider_id = row.provider_id, "connection revoked");
        let provider_revocation = match (provider, config.as_ref(), token_set.as_ref()) {
            (Some(provider), Some(config), Some(tokens)) => {
                self.revoke_issued_tokens(provider, config, tokens).await
            }
            _ => ProviderRevocation::Unsupported,
        };

        Ok(RevokeOutcome {
            revoked: true,
            provider_revocation,
        })
    }

    /// Local revocation is authoritative; the upstream call is a courtesy whose
    /// outcome is reported rather than enforced.
    async fn revoke_issued_tokens(
        &self,
        provider: &Provider,
        config: &BrokerConfig,
        tokens: &TokenSet,
    ) -> ProviderRevocation {
        #[cfg(test)]
        {
            let mut attempts = self.cleanup_attempts.lock().expect("cleanup lock");
            if let Some(refresh_token) = tokens.refresh_token.as_deref() {
                attempts.push(refresh_token.to_string());
            }
            attempts.push(tokens.access_token.clone());
        }
        let AuthMethod::OAuth2AuthCode {
            revoke_url: Some(_),
            ..
        } = &provider.auth
        else {
            return ProviderRevocation::Unsupported;
        };
        let mut failed = false;
        if let Some(refresh_token) = tokens.refresh_token.as_deref() {
            failed |= flow::revoke_upstream(&self.http, provider, config, refresh_token)
                .await
                .is_err();
        }
        failed |= flow::revoke_upstream(&self.http, provider, config, &tokens.access_token)
            .await
            .is_err();
        if failed {
            ProviderRevocation::Failed
        } else {
            ProviderRevocation::Ok
        }
    }

    // ---- bindings ------------------------------------------------------------

    pub async fn bind(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        request: BindRequest,
    ) -> Result<ConnectionView> {
        let row = self.row_in_org(organization_id, id).await?;
        if request.target_id.trim().is_empty() {
            return Err(BrokerError::Invalid("target_id is empty".into()));
        }
        store::insert_binding(
            &self.pool,
            &row.id,
            request.target_kind,
            request.target_id.trim(),
            request.target_label.as_deref(),
        )
        .await?;
        store::append_event(
            &self.pool,
            &row.id,
            EventKind::Bound,
            Some(request.target_kind.as_str()),
        )
        .await?;
        self.view(row).await
    }

    pub async fn unbind(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        binding_id: &str,
    ) -> Result<ConnectionView> {
        let row = self.row_in_org(organization_id, id).await?;
        store::delete_binding(&self.pool, &row.id, binding_id).await?;
        store::append_event(&self.pool, &row.id, EventKind::Unbound, None).await?;
        self.view(row).await
    }

    pub async fn update_policy(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        shareability: Shareability,
        max_invoke_level: u8,
    ) -> Result<ConnectionView> {
        if !(1..=2).contains(&max_invoke_level) {
            return Err(BrokerError::Invalid(
                "max_invoke_level must be 1 or 2".into(),
            ));
        }
        let row = self.row_in_org(organization_id, id).await?;
        store::update_policy(
            &self.pool,
            &row.id,
            &row.organization_id,
            shareability_str(shareability),
            max_invoke_level,
        )
        .await?;
        store::append_event(&self.pool, &row.id, EventKind::PolicyUpdated, None).await?;
        self.get_connection_unscoped(&row.id).await
    }

    // ---- internals -----------------------------------------------------------

    async fn get_connection_unscoped(&self, id: &str) -> Result<ConnectionView> {
        let row = store::get_connection(&self.pool, id)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
        self.view(row).await
    }

    async fn store_tokens(
        &self,
        key: &[u8; 32],
        row: &ConnectionRow,
        tokens: &TokenSet,
        activation: TokenActivation<'_>,
    ) -> Result<store::CredentialActivationOutcome> {
        let plaintext = serde_json::to_vec(tokens)?;
        let sealed = crypto::seal(key, &row.id, &row.organization_id, &plaintext)?;
        let previous = store::get_credential(&self.pool, &row.id).await?;
        let expected_credential_version =
            activation.expected_credential_version.unwrap_or_else(|| {
                previous
                    .as_ref()
                    .map(|credential| credential.version.as_str())
            });
        let credential = CredentialRow {
            connection_id: row.id.clone(),
            version: uuid::Uuid::now_v7().to_string(),
            sealed,
            token_type: tokens.token_type.clone(),
            expires_at: tokens.expires_at,
            refreshable: tokens.refreshable(),
            last_refreshed_at: activation
                .refreshed_at
                .or(previous.as_ref().and_then(|p| p.last_refreshed_at)),
            configured_field_names: tokens.configuration.keys().cloned().collect(),
        };
        let request = store::CredentialActivation {
            credential: &credential,
            organization_id: &row.organization_id,
            integration_id: &row.integration_id,
            expected_integration_updated_at: activation.expected_integration_updated_at,
            requested_scopes: &row.requested_scopes,
            granted_scopes: &tokens.scopes,
            account_label: activation.account_label,
            event_kind: activation.event_kind,
            event_detail: activation.event_detail,
            expected_credential_version,
        };
        // SQLite has one writer; serialize this broker's activations in-process.
        // The persisted generation CAS remains authoritative across processes.
        let _activation_guard = self.activation_lock.lock().await;
        for attempt in 0..4 {
            match store::activate_credential_unless_revoked(&self.pool, request).await {
                Err(error) if attempt < 3 && sqlite_writer_race(&error) => {
                    tokio::time::sleep(Duration::from_millis(1 << attempt)).await;
                }
                result => return result,
            }
        }
        unreachable!("bounded activation retry returns from every branch")
    }

    fn open_tokens(
        &self,
        key: &[u8; 32],
        row: &ConnectionRow,
        credential: &CredentialRow,
    ) -> Result<TokenSet> {
        let plaintext = crypto::open(key, &row.id, &row.organization_id, &credential.sealed)?;
        serde_json::from_slice(&plaintext).map_err(BrokerError::from)
    }

    async fn view(&self, row: ConnectionRow) -> Result<ConnectionView> {
        let bindings = store::list_bindings(&self.pool, &row.id).await?;
        let credential = store::get_credential(&self.pool, &row.id).await?;
        let refreshable = credential.as_ref().is_some_and(|c| c.refreshable);
        let expires_at = credential.as_ref().and_then(|c| c.expires_at);
        let status = effective_status(row.status, expires_at, refreshable);

        Ok(ConnectionView {
            connection_id: row.id.clone(),
            integration_id: (!row.integration_id.is_empty()).then_some(row.integration_id.clone()),
            connection_ref: connection_ref_uri(&row),
            logical_name: row.logical_name.clone(),
            display_name: row.display_name.clone(),
            provider_id: row.provider_id.clone(),
            status,
            status_detail: row.status_detail.clone(),
            organization_id: row.organization_id.clone(),
            project_id: row.project_id.clone(),
            owner_kind: parse_owner_kind(&row.owner_kind),
            shareability: parse_shareability(&row.shareability),
            requested_scopes: row.requested_scopes.clone(),
            granted_scopes: row.granted_scopes.clone(),
            account_label: row.account_label.clone(),
            expires_at: expires_at.map(|t| t.to_rfc3339()),
            refreshable,
            configured_fields: credential
                .as_ref()
                .map(|credential| {
                    credential
                        .configured_field_names
                        .iter()
                        .map(|name| crate::model::ConfiguredFieldView {
                            name: name.clone(),
                            hint: Some("configured".into()),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            last_refreshed_at: credential
                .as_ref()
                .and_then(|c| c.last_refreshed_at)
                .map(|t| t.to_rfc3339()),
            max_invoke_level: row.max_invoke_level,
            egress: EgressView::from(&row.egress),
            bindings,
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
        })
    }
}

/// An access token past its expiry with nothing to refresh it with is `expired`,
/// whatever the row last recorded.
fn effective_status(
    stored: ConnectionStatus,
    expires_at: Option<chrono::DateTime<Utc>>,
    refreshable: bool,
) -> ConnectionStatus {
    if stored == ConnectionStatus::Active
        && !refreshable
        && expires_at.is_some_and(|e| Utc::now() >= e)
    {
        return ConnectionStatus::Expired;
    }
    stored
}

/// ADR 0005 URI. Ids that predate the typed form still yield a `conn://` URI —
/// the agent surface must never be left without a reference to name.
fn connection_ref_uri(row: &ConnectionRow) -> String {
    let project = match row.project_id.as_deref() {
        Some(raw) => match ProjectId::parse(raw) {
            Ok(p) => Some(p),
            Err(_) => return fallback_ref_uri(row),
        },
        None => None,
    };
    let (Ok(organization), Ok(connection_id)) = (
        OrganizationId::parse(&row.organization_id),
        ConnectionId::parse(&row.id),
    ) else {
        return fallback_ref_uri(row);
    };
    match ConnectionRef::new(
        organization,
        project,
        row.logical_name.clone(),
        connection_id,
    ) {
        Ok(reference) => reference.handle.uri(),
        Err(_) => fallback_ref_uri(row),
    }
}

/// The same shape `AuthorityHandle::uri` produces, built from the stored strings
/// rather than from ids we could not parse.
fn fallback_ref_uri(row: &ConnectionRow) -> String {
    match row.project_id.as_deref() {
        Some(project) => format!(
            "conn://{}/{project}/{}",
            row.organization_id, row.logical_name
        ),
        None => format!("conn://{}/{}", row.organization_id, row.logical_name),
    }
}

fn owner_kind_str(kind: ConnectionOwnerKind) -> &'static str {
    match kind {
        ConnectionOwnerKind::Individual => "individual",
        ConnectionOwnerKind::Organization => "organization",
        ConnectionOwnerKind::Project => "project",
        ConnectionOwnerKind::Service => "service",
        ConnectionOwnerKind::Workload => "workload",
        ConnectionOwnerKind::Device => "device",
    }
}

fn parse_owner_kind(raw: &str) -> ConnectionOwnerKind {
    match raw {
        "individual" => ConnectionOwnerKind::Individual,
        "project" => ConnectionOwnerKind::Project,
        "service" => ConnectionOwnerKind::Service,
        "workload" => ConnectionOwnerKind::Workload,
        "device" => ConnectionOwnerKind::Device,
        _ => ConnectionOwnerKind::Organization,
    }
}

/// Providers whose REST APIs accept a personal access token as a Bearer
/// credential (same shape as an OAuth access token). Enables Host-mediated
/// history setup without registering an OAuth App.
pub fn accepts_pasted_access_token(provider_id: &str) -> bool {
    matches!(provider_id, "github" | "gitlab")
}

pub fn shareability_str(s: Shareability) -> &'static str {
    match s {
        Shareability::Private => "private",
        Shareability::Delegable => "delegable",
        Shareability::OrganizationWide => "organization_wide",
    }
}

pub fn parse_shareability(raw: &str) -> Shareability {
    match raw {
        "delegable" => Shareability::Delegable,
        "organization_wide" => Shareability::OrganizationWide,
        _ => Shareability::Private,
    }
}

/// The egress a provider's credential may reach, for callers wiring ADR 0005
/// enforcement around a connection.
pub fn provider_egress(provider_id: &str) -> Result<Option<EgressBinding>> {
    Ok(catalog::find(provider_id)?.map(|provider| provider.egress.binding()))
}

#[cfg(test)]
mod tests;
