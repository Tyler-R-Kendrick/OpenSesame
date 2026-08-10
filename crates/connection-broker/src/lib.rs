//! Connection broker: acquires third-party authorizations and holds them in the
//! authority plane (ADR 0032).
//!
//! The vault is sealed against the server by design; a connection credential is
//! deliberately the opposite, because refresh happens while the human is absent.
//! What that buys is bounded by two rules enforced here: the credential is sealed
//! under a deployment key bound to its tenant, and nothing on the API boundary
//! carries token material — callers get a [`ConnectionRef`] and status.

pub mod catalog;
pub mod config;
pub mod crypto;
pub mod error;
pub mod flow;
pub mod model;
pub mod store;
pub mod token;

use std::time::Duration;

use chrono::Utc;
use opensesame_domain::{
    ConnectionId, ConnectionOwnerKind, ConnectionRef, EgressBinding, OrganizationId, ProjectId,
    Shareability,
};
use sqlx::SqlitePool;

pub use crate::catalog::{AuthMethod, Provider};
pub use crate::config::{BrokerConfig, ProviderConfig};
pub use crate::error::{BrokerError, Result};
pub use crate::model::*;

use crate::store::{AuthorizationRow, ConnectionRow, CredentialRow};
use crate::token::TokenSet;

/// A connection's ceiling is constrained HTTP inside its provider's egress
/// allowlist; materialization stays denied (ADR 0005).
const DEFAULT_MAX_INVOKE_LEVEL: u8 = 2;
/// Longest API key this will seal and store. Real keys are a few hundred bytes;
/// anything larger is a payload aimed at the shared store.
pub const MAX_CREDENTIAL_BYTES: usize = 8 * 1024;

pub struct ConnectionBroker {
    pool: SqlitePool,
    config: BrokerConfig,
    http: reqwest::Client,
}

impl ConnectionBroker {
    pub fn new(pool: SqlitePool, config: BrokerConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Self { pool, config, http }
    }

    pub fn config(&self) -> &BrokerConfig {
        &self.config
    }

    // ---- catalog -------------------------------------------------------------

    pub fn list_providers(&self) -> Vec<ProviderView> {
        catalog::all()
            .iter()
            .map(|p| {
                let missing = self.config.missing_config(p);
                ProviderView::new(p, missing.is_empty(), missing)
            })
            .collect()
    }

    fn provider(&self, id: &str) -> Result<&'static Provider> {
        catalog::find(id).ok_or_else(|| BrokerError::ProviderUnknown(id.to_string()))
    }

    fn require_configured(&self, provider: &Provider) -> Result<()> {
        let missing = self.config.missing_config(provider);
        if missing.is_empty() {
            Ok(())
        } else {
            Err(BrokerError::ProviderUnconfigured {
                provider: provider.id.to_string(),
                missing,
            })
        }
    }

    fn sealing_key(&self) -> Result<&[u8; 32]> {
        self.config.key().ok_or_else(|| {
            BrokerError::SealUnavailable(format!("{} is not set", config::ENV_CONNECTION_KEY))
        })
    }

    // ---- connections ---------------------------------------------------------

    pub async fn create_connection(
        &self,
        organization_id: &OrganizationId,
        request: CreateConnection,
    ) -> Result<ConnectionView> {
        let provider = self.provider(&request.provider_id)?;
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
            None => self.unused_logical_name(&organization, provider.id).await?,
        };

        let now = Utc::now();
        let row = ConnectionRow {
            id: opensesame_domain::ConnectionId::new().to_string(),
            organization_id: organization,
            project_id: request.project_id.filter(|p| !p.is_empty()),
            provider_id: provider.id.to_string(),
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
                .unwrap_or_else(|| provider.default_scopes()),
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

        store::insert_connection(&self.pool, &row).await?;
        store::append_event(&self.pool, &row.id, EventKind::Created, Some(provider.id)).await?;
        tracing::info!(connection_id = %row.id, provider_id = provider.id, "connection created");
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
        let row = self.row_in_org(organization_id, id).await?;
        if row.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid(
                "connection is revoked; create a new one".into(),
            ));
        }
        let provider = self.provider(&row.provider_id)?;
        if !provider.auth.is_oauth() {
            return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
        }
        self.require_configured(provider)?;
        // Refuse before sending a human to a consent screen whose result we could
        // not store.
        self.sealing_key()?;

        let redirect_uri = match redirect_uri.filter(|r| !r.trim().is_empty()) {
            Some(uri) => {
                if !self.config.redirect_allowed(provider.id, uri.trim()) {
                    return Err(BrokerError::RedirectNotAllowed);
                }
                uri.trim().to_string()
            }
            None => self.config.callback_url(provider.id),
        };

        let scopes = match scopes.filter(|s| !s.is_empty()) {
            Some(s) => {
                store::set_requested_scopes(&self.pool, &row.id, &s).await?;
                s
            }
            None => row.requested_scopes.clone(),
        };

        let pkce = flow::Pkce::generate();
        let state = flow::new_state();
        let expires_at = Utc::now() + chrono::Duration::seconds(flow::STATE_TTL_SECONDS);
        let authorization_url = flow::build_authorize_url(
            provider,
            &self.config,
            flow::AuthorizeParams {
                client_id: &self
                    .config
                    .provider(provider.id)
                    .client_id
                    .unwrap_or_default(),
                redirect_uri: &redirect_uri,
                scopes: &scopes,
                state: &state,
                code_challenge: &pkce.challenge,
            },
        )?;

        store::insert_authorization(
            &self.pool,
            &AuthorizationRow {
                state: state.clone(),
                connection_id: row.id.clone(),
                code_verifier: pkce.verifier,
                redirect_uri,
                scopes,
                expires_at,
            },
        )
        .await?;
        store::append_event(
            &self.pool,
            &row.id,
            EventKind::AuthorizeStarted,
            Some(provider.id),
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
        let authorization = store::consume_authorization(&self.pool, state, Utc::now()).await?;
        let row = store::get_connection(&self.pool, &authorization.connection_id)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
        // A state belongs to one connection and therefore to one provider; a
        // callback arriving on another provider's path is not this state's.
        if row.provider_id != provider_id {
            return Err(BrokerError::InvalidState);
        }
        let provider = self.provider(&row.provider_id)?;
        let key = *self.sealing_key()?;

        let response = match flow::exchange_code(
            &self.http,
            provider,
            &self.config,
            code,
            &authorization.code_verifier,
            &authorization.redirect_uri,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                let detail = e.hint();
                store::set_status(&self.pool, &row.id, ConnectionStatus::Error, Some(&detail))
                    .await?;
                store::append_event(&self.pool, &row.id, EventKind::Error, Some(&detail)).await?;
                tracing::warn!(connection_id = %row.id, provider_id = provider.id, "token exchange failed");
                return Err(e);
            }
        };

        let account_label = response.account_label();
        let tokens = response.into_token_set(Utc::now(), &authorization.scopes);
        self.store_tokens(&key, &row, &tokens, None).await?;
        store::set_grant_details(
            &self.pool,
            &row.id,
            &tokens.scopes,
            account_label.as_deref(),
        )
        .await?;
        store::set_status(&self.pool, &row.id, ConnectionStatus::Active, None).await?;
        store::append_event(
            &self.pool,
            &row.id,
            EventKind::Authorized,
            Some(provider.id),
        )
        .await?;
        tracing::info!(connection_id = %row.id, provider_id = provider.id, "connection authorized");

        self.get_connection_unscoped(&row.id).await
    }

    pub async fn refresh(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<ConnectionView> {
        let row = self.row_in_org(organization_id, id).await?;
        let provider = self.provider(&row.provider_id)?;
        let key = *self.sealing_key()?;

        let credential = store::get_credential(&self.pool, &row.id)
            .await?
            .ok_or(BrokerError::NotRefreshable)?;
        let tokens = self.open_tokens(&key, &row, &credential)?;
        if !tokens.refreshable() || !provider.auth.supports_refresh() {
            return Err(BrokerError::NotRefreshable);
        }
        self.require_configured(provider)?;

        match token::refresh(&self.http, provider, &self.config, &tokens).await {
            Ok(next) => {
                let now = Utc::now();
                self.store_tokens(&key, &row, &next, Some(now)).await?;
                store::set_grant_details(&self.pool, &row.id, &next.scopes, None).await?;
                store::set_status(&self.pool, &row.id, ConnectionStatus::Active, None).await?;
                store::append_event(&self.pool, &row.id, EventKind::Refreshed, None).await?;
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
                store::set_status(
                    &self.pool,
                    &row.id,
                    ConnectionStatus::NeedsReauth,
                    Some(&detail),
                )
                .await?;
                store::append_event(&self.pool, &row.id, EventKind::RefreshFailed, Some(&detail))
                    .await?;
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
        let row = self.row_in_org(organization_id, id).await?;
        let provider = self.provider(&row.provider_id)?;
        let AuthMethod::ApiKey { .. } = provider.auth else {
            return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
        };
        if value.trim().is_empty() {
            return Err(BrokerError::Invalid("credential value is empty".into()));
        }
        // A credential is a key, not a payload. Checked before sealing and storing,
        // so an oversized one costs neither the AEAD nor the shared database.
        if value.trim().len() > MAX_CREDENTIAL_BYTES {
            return Err(BrokerError::Invalid(format!(
                "credential value exceeds {MAX_CREDENTIAL_BYTES} bytes"
            )));
        }
        let key = *self.sealing_key()?;

        let tokens = TokenSet {
            access_token: value.trim().to_string(),
            refresh_token: None,
            token_type: "api_key".into(),
            expires_at: None,
            scopes: Vec::new(),
        };
        self.store_tokens(&key, &row, &tokens, None).await?;
        store::set_status(&self.pool, &row.id, ConnectionStatus::Active, None).await?;
        store::append_event(
            &self.pool,
            &row.id,
            EventKind::Authorized,
            Some("api key stored"),
        )
        .await?;
        tracing::info!(connection_id = %row.id, provider_id = provider.id, "api key stored");
        self.get_connection_unscoped(&row.id).await
    }

    pub async fn revoke(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<RevokeOutcome> {
        let row = self.row_in_org(organization_id, id).await?;
        let provider = self.provider(&row.provider_id)?;

        let provider_revocation = self.revoke_upstream(provider, &row).await;
        store::delete_credential(&self.pool, &row.id).await?;
        store::set_status(&self.pool, &row.id, ConnectionStatus::Revoked, None).await?;
        store::append_event(&self.pool, &row.id, EventKind::Revoked, None).await?;
        tracing::info!(connection_id = %row.id, provider_id = provider.id, "connection revoked");

        Ok(RevokeOutcome {
            revoked: true,
            provider_revocation,
        })
    }

    /// Local revocation is authoritative; the upstream call is a courtesy whose
    /// outcome is reported rather than enforced.
    async fn revoke_upstream(
        &self,
        provider: &Provider,
        row: &ConnectionRow,
    ) -> ProviderRevocation {
        let AuthMethod::OAuth2AuthCode {
            revoke_url: Some(_),
            ..
        } = provider.auth
        else {
            return ProviderRevocation::Unsupported;
        };
        let Some(key) = self.config.key() else {
            return ProviderRevocation::Unsupported;
        };
        let Ok(Some(credential)) = store::get_credential(&self.pool, &row.id).await else {
            return ProviderRevocation::Unsupported;
        };
        let Ok(tokens) = self.open_tokens(key, row, &credential) else {
            return ProviderRevocation::Failed;
        };
        match flow::revoke_upstream(&self.http, provider, &self.config, &tokens.access_token).await
        {
            Ok(()) => ProviderRevocation::Ok,
            Err(BrokerError::UnsupportedCredential(_)) => ProviderRevocation::Unsupported,
            Err(_) => ProviderRevocation::Failed,
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
        refreshed_at: Option<chrono::DateTime<Utc>>,
    ) -> Result<()> {
        let plaintext = serde_json::to_vec(tokens)?;
        let sealed = crypto::seal(key, &row.id, &row.organization_id, &plaintext)?;
        let previous = store::get_credential(&self.pool, &row.id).await?;
        store::upsert_credential(
            &self.pool,
            &CredentialRow {
                connection_id: row.id.clone(),
                sealed,
                token_type: tokens.token_type.clone(),
                expires_at: tokens.expires_at,
                refreshable: tokens.refreshable(),
                last_refreshed_at: refreshed_at.or(previous.and_then(|p| p.last_refreshed_at)),
            },
        )
        .await
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
pub fn provider_egress(provider_id: &str) -> Option<EgressBinding> {
    catalog::find(provider_id).map(|p| p.egress.binding())
}

#[cfg(test)]
mod tests;
