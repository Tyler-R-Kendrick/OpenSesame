//! Host sync targets: project config → connector fan-out (Doppler-parity sync).
//!
//! Agents never receive secret values. Sync loads authority-plane sealed
//! connection credentials on Host, authorizes via active ConnectionRef, and
//! invokes provider egress (`env.set` / `secrets.sync`). Catalog `doppler` is a
//! SaaS connector — not this path — and nothing shells out to the Doppler CLI.

use std::collections::BTreeMap;
use std::sync::Arc;

use chrono::Utc;
use opensesame_domain::OrganizationId;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{BrokerError, Result};
use crate::model::ConnectionStatus;
use crate::store::{self, SyncTargetRow};
use crate::token::TokenSet;
use crate::ConnectionBroker;

/// Frozen domain status vocabulary (WP-B / ADR 0041).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncTargetStatus {
    Idle,
    Syncing,
    Ready,
    Error,
}

impl SyncTargetStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Syncing => "syncing",
            Self::Ready => "ready",
            Self::Error => "error",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "syncing" => Self::Syncing,
            "ready" => Self::Ready,
            "error" => Self::Error,
            _ => Self::Idle,
        }
    }
}

/// Wire view — no secret fields by construction (snake_case Host contract).
#[derive(Clone, Debug, Serialize)]
pub struct SyncTargetView {
    pub id: String,
    pub project_id: String,
    pub config_id: String,
    pub connection_id: String,
    pub provider_id: String,
    pub operation: String,
    pub status: SyncTargetStatus,
    pub status_detail: Option<String>,
    pub content_version: Option<String>,
    pub last_synced_at: Option<String>,
    pub organization_id: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<SyncTargetRow> for SyncTargetView {
    fn from(row: SyncTargetRow) -> Self {
        Self {
            id: row.id,
            project_id: row.project_id,
            config_id: row.config_id,
            connection_id: row.connection_id,
            provider_id: row.provider_id,
            operation: row.operation,
            status: SyncTargetStatus::parse(&row.status),
            status_detail: row.status_detail,
            content_version: row.content_version,
            last_synced_at: row.last_synced_at,
            organization_id: row.organization_id,
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CreateSyncTarget {
    pub project_id: String,
    pub config_id: String,
    pub connection_id: String,
    pub operation: Option<String>,
}

/// Result of syncing one target. Never carries secret values.
#[derive(Clone, Debug, Serialize)]
pub struct SyncOutcome {
    pub target: SyncTargetView,
    pub ok: bool,
    pub keys_synced: usize,
    pub content_version: Option<String>,
    pub error: Option<String>,
}

/// Host-side authority secret loader for a project config.
///
/// Implementations must never expose values on agent-facing surfaces; this trait
/// is only consumed inside Host sync egress.
#[async_trait::async_trait]
pub trait SyncSecretSource: Send + Sync {
    async fn load_config_secrets(
        &self,
        organization_id: &str,
        project_id: &str,
        config_id: &str,
    ) -> Result<BTreeMap<String, String>>;
}

/// Empty source — sync authorizes and records ready with zero keys.
#[derive(Default)]
pub struct EmptySecretSource;

#[async_trait::async_trait]
impl SyncSecretSource for EmptySecretSource {
    async fn load_config_secrets(
        &self,
        _organization_id: &str,
        _project_id: &str,
        _config_id: &str,
    ) -> Result<BTreeMap<String, String>> {
        Ok(BTreeMap::new())
    }
}

/// In-memory map for unit tests.
#[derive(Default)]
pub struct MapSecretSource {
    pub entries: BTreeMap<String, String>,
}

#[async_trait::async_trait]
impl SyncSecretSource for MapSecretSource {
    async fn load_config_secrets(
        &self,
        _organization_id: &str,
        _project_id: &str,
        _config_id: &str,
    ) -> Result<BTreeMap<String, String>> {
        Ok(self.entries.clone())
    }
}

const SYNC_OPS: &[&str] = &["env.set", "secrets.sync"];

fn default_operation(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "vercel" | "railway" => Some("env.set"),
        _ => None,
    }
}

fn operation_allowed(provider_id: &str, operation: &str) -> Result<()> {
    let provider = crate::catalog::find(provider_id)?
        .ok_or_else(|| BrokerError::ProviderUnknown(provider_id.to_string()))?;
    if !SYNC_OPS.contains(&operation) {
        return Err(BrokerError::Invalid(format!(
            "operation `{operation}` is not a sync fan-out operation"
        )));
    }
    if !provider.operations.iter().any(|op| op == operation) {
        return Err(BrokerError::Invalid(format!(
            "provider `{provider_id}` does not advertise `{operation}`"
        )));
    }
    Ok(())
}

impl ConnectionBroker {
    pub async fn create_sync_target(
        &self,
        organization_id: &OrganizationId,
        request: CreateSyncTarget,
    ) -> Result<SyncTargetView> {
        let project_id = request.project_id.trim();
        let config_id = request.config_id.trim();
        let connection_id = request.connection_id.trim();
        if project_id.is_empty() || config_id.is_empty() || connection_id.is_empty() {
            return Err(BrokerError::Invalid(
                "project_id, config_id, and connection_id are required".into(),
            ));
        }
        let connection = self.row_in_org(organization_id, connection_id).await?;
        let operation = match request
            .operation
            .as_deref()
            .map(str::trim)
            .filter(|op| !op.is_empty())
        {
            Some(op) => op.to_string(),
            None => default_operation(&connection.provider_id)
                .ok_or_else(|| {
                    BrokerError::Invalid(format!(
                        "provider `{}` has no default sync operation; pass operation",
                        connection.provider_id
                    ))
                })?
                .to_string(),
        };
        operation_allowed(&connection.provider_id, &operation)?;

        let now = Utc::now();
        let row = SyncTargetRow {
            id: format!("sync_target:{}", uuid::Uuid::now_v7()),
            organization_id: organization_id.to_string(),
            project_id: project_id.to_string(),
            config_id: config_id.to_string(),
            connection_id: connection.id.clone(),
            provider_id: connection.provider_id.clone(),
            operation,
            status: SyncTargetStatus::Idle.as_str().into(),
            status_detail: None,
            content_version: None,
            last_synced_at: None,
            created_at: now,
            updated_at: now,
        };
        store::insert_sync_target(&self.pool, &row).await?;
        // CHANGELOG_HOOK: sync.target.created — WP-D wires record_secret_changelog
        crate::record_secret_changelog(crate::RecordSecretChangelog {
            event_type: "sync.target.created".into(),
            project_id: row.project_id.clone(),
            organization_id: Some(organization_id.to_string()),
            config_id: Some(row.config_id.clone()),
            target_id: Some(row.id.clone()),
            key_names: Vec::new(),
            ..Default::default()
        });
        tracing::info!(
            sync_target_id = %row.id,
            project_id = %row.project_id,
            config_id = %row.config_id,
            "sync target created"
        );
        Ok(SyncTargetView::from(row))
    }

    pub async fn list_sync_targets(
        &self,
        organization_id: &OrganizationId,
        project_id: Option<&str>,
        config_id: Option<&str>,
    ) -> Result<Vec<SyncTargetView>> {
        let rows = store::list_sync_targets(
            &self.pool,
            &organization_id.to_string(),
            project_id,
            config_id,
        )
        .await?;
        Ok(rows.into_iter().map(SyncTargetView::from).collect())
    }

    pub async fn get_sync_target(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<SyncTargetView> {
        let row = self.sync_target_in_org(organization_id, id).await?;
        Ok(SyncTargetView::from(row))
    }

    pub async fn delete_sync_target(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<()> {
        if !store::delete_sync_target(&self.pool, &organization_id.to_string(), id).await? {
            return Err(BrokerError::SyncTargetNotFound);
        }
        Ok(())
    }

    /// Sync one target: load sealed credentials, authorize, invoke egress.
    /// Never returns secret values.
    pub async fn sync_target(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        secrets: Arc<dyn SyncSecretSource>,
    ) -> Result<SyncOutcome> {
        let row = self.sync_target_in_org(organization_id, id).await?;
        if SyncTargetStatus::parse(&row.status) == SyncTargetStatus::Syncing {
            return Err(BrokerError::Invalid(
                "sync already in progress for this target".into(),
            ));
        }
        store::update_sync_target_status(
            &self.pool,
            &row.id,
            SyncTargetStatus::Syncing.as_str(),
            None,
            None,
            None,
        )
        .await?;

        let result = self
            .run_sync(organization_id, &row, secrets.as_ref())
            .await;

        match result {
            Ok((keys_synced, content_version, key_names)) => {
                let synced_at = Utc::now().to_rfc3339();
                store::update_sync_target_status(
                    &self.pool,
                    &row.id,
                    SyncTargetStatus::Ready.as_str(),
                    None,
                    Some(&content_version),
                    Some(&synced_at),
                )
                .await?;
                // CHANGELOG_HOOK: sync.target.synced — WP-D wires record_secret_changelog
                // (metadata: target id + content_version only; never secret bodies)
                crate::record_secret_changelog(crate::RecordSecretChangelog {
                    event_type: "sync.target.synced".into(),
                    project_id: row.project_id.clone(),
                    organization_id: Some(organization_id.to_string()),
                    config_id: Some(row.config_id.clone()),
                    target_id: Some(row.id.clone()),
                    content_version: Some(content_version.clone()),
                    key_names,
                    ..Default::default()
                });
                let target = self.get_sync_target(organization_id, &row.id).await?;
                Ok(SyncOutcome {
                    target,
                    ok: true,
                    keys_synced,
                    content_version: Some(content_version),
                    error: None,
                })
            }
            Err(error) => {
                let detail = error.hint();
                store::update_sync_target_status(
                    &self.pool,
                    &row.id,
                    SyncTargetStatus::Error.as_str(),
                    Some(&detail),
                    None,
                    None,
                )
                .await?;
                // CHANGELOG_HOOK: sync.target.failed — WP-D wires record_secret_changelog
                crate::record_secret_changelog(crate::RecordSecretChangelog {
                    event_type: "sync.target.failed".into(),
                    project_id: row.project_id.clone(),
                    organization_id: Some(organization_id.to_string()),
                    config_id: Some(row.config_id.clone()),
                    target_id: Some(row.id.clone()),
                    key_names: Vec::new(),
                    metadata: {
                        let mut m = serde_json::Map::new();
                        m.insert("reason".into(), json!(error.code()));
                        m
                    },
                    ..Default::default()
                });
                let target = self.get_sync_target(organization_id, &row.id).await?;
                Ok(SyncOutcome {
                    target,
                    ok: false,
                    keys_synced: 0,
                    content_version: None,
                    error: Some(detail),
                })
            }
        }
    }

    /// Fan-out: sync every target for a config. Partial failure records per-target
    /// error without aborting siblings.
    pub async fn sync_all_for_config(
        &self,
        organization_id: &OrganizationId,
        config_id: &str,
        secrets: Arc<dyn SyncSecretSource>,
    ) -> Result<Vec<SyncOutcome>> {
        let targets = store::list_sync_targets(
            &self.pool,
            &organization_id.to_string(),
            None,
            Some(config_id),
        )
        .await?;
        let mut outcomes = Vec::with_capacity(targets.len());
        for target in targets {
            let outcome = self
                .sync_target(organization_id, &target.id, Arc::clone(&secrets))
                .await?;
            outcomes.push(outcome);
        }
        Ok(outcomes)
    }

    async fn sync_target_in_org(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<SyncTargetRow> {
        let row = store::get_sync_target(&self.pool, id)
            .await?
            .ok_or(BrokerError::SyncTargetNotFound)?;
        if row.organization_id != organization_id.to_string() {
            return Err(BrokerError::SyncTargetNotFound);
        }
        Ok(row)
    }

    async fn run_sync(
        &self,
        organization_id: &OrganizationId,
        target: &SyncTargetRow,
        secrets: &dyn SyncSecretSource,
    ) -> Result<(usize, String, Vec<String>)> {
        operation_allowed(&target.provider_id, &target.operation)?;
        let connection = self
            .row_in_org(organization_id, &target.connection_id)
            .await?;
        if connection.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid("connection is revoked".into()));
        }
        if connection.status != ConnectionStatus::Active {
            return Err(BrokerError::NeedsReauth(format!(
                "connection status is {}",
                connection.status.as_str()
            )));
        }
        if connection.provider_id != target.provider_id {
            return Err(BrokerError::Invalid(
                "sync target provider_id no longer matches connection".into(),
            ));
        }

        let key = *self.sealing_key()?;
        let credential = store::get_credential(&self.pool, &connection.id)
            .await?
            .ok_or_else(|| BrokerError::NeedsReauth("connection has no credential".into()))?;
        let tokens = self.open_tokens(&key, &connection, &credential)?;
        if tokens.access_token.is_empty() {
            return Err(BrokerError::NeedsReauth("access token missing".into()));
        }

        let entries = secrets
            .load_config_secrets(
                &organization_id.to_string(),
                &target.project_id,
                &target.config_id,
            )
            .await?;
        let key_names: Vec<String> = entries.keys().cloned().collect();
        let content_version = content_version_for(&target.id, &key_names);

        self.invoke_env_sync(
            &target.provider_id,
            &target.operation,
            &tokens,
            &entries,
            &target.project_id,
            &target.config_id,
        )
        .await?;

        Ok((entries.len(), content_version, key_names))
    }

    /// Push env/secret names to the provider. Values stay on Host egress only.
    async fn invoke_env_sync(
        &self,
        provider_id: &str,
        operation: &str,
        tokens: &TokenSet,
        entries: &BTreeMap<String, String>,
        project_id: &str,
        config_id: &str,
    ) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        match provider_id {
            "vercel" => self.sync_vercel(tokens, entries, project_id, config_id).await,
            "railway" => {
                self.sync_railway(tokens, entries, project_id, config_id)
                    .await
            }
            _ => Err(BrokerError::Invalid(format!(
                "sync invoke for provider `{provider_id}` / `{operation}` is not implemented"
            ))),
        }
    }

    async fn sync_vercel(
        &self,
        tokens: &TokenSet,
        entries: &BTreeMap<String, String>,
        project_id: &str,
        config_id: &str,
    ) -> Result<()> {
        let url = format!("https://api.vercel.com/v10/projects/{project_id}/env");
        for (name, value) in entries {
            let body = json!({
                "key": name,
                "value": value,
                "type": "encrypted",
                "target": [config_id],
            });
            self.http_provider_json(tokens, "POST", &url, Some(body), "api.vercel.com")
                .await
                .map_err(BrokerError::ExchangeFailed)?;
        }
        Ok(())
    }

    async fn sync_railway(
        &self,
        tokens: &TokenSet,
        entries: &BTreeMap<String, String>,
        project_id: &str,
        config_id: &str,
    ) -> Result<()> {
        let url = "https://backboard.railway.com/graphql/v2";
        let variables: BTreeMap<&str, &str> = entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let body = json!({
            "query": "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }",
            "variables": {
                "input": {
                    "projectId": project_id,
                    "environmentId": config_id,
                    "variables": variables,
                }
            }
        });
        self.http_provider_json(tokens, "POST", url, Some(body), "backboard.railway.com")
            .await
            .map_err(BrokerError::ExchangeFailed)?;
        Ok(())
    }

    async fn http_provider_json(
        &self,
        tokens: &TokenSet,
        method: &str,
        url: &str,
        body: Option<Value>,
        authority: &str,
    ) -> std::result::Result<Value, String> {
        let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
        if parsed.scheme() != "https" {
            return Err("sync egress requires https".into());
        }
        if parsed.host_str() != Some(authority) {
            return Err(format!("destination host is not {authority}"));
        }
        let method = method
            .parse::<reqwest::Method>()
            .map_err(|_| format!("unsupported method {method}"))?;
        let mut req = self
            .http
            .request(method, url)
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("Accept", "application/json")
            .header("User-Agent", "OpenSesame-Host/0.1");
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let text = res.text().await.map_err(|e| e.to_string())?;
        if !(200..300).contains(&status.as_u16()) {
            let snippet: String = text.chars().take(240).collect();
            return Err(format!("upstream {status}: {snippet}"));
        }
        if text.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}

fn content_version_for(target_id: &str, key_names: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(target_id.as_bytes());
    hasher.update(b"|");
    for name in key_names {
        hasher.update(name.as_bytes());
        hasher.update(b",");
    }
    format!("cv_{:x}", hasher.finalize())
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn status_vocabulary() {
        assert_eq!(SyncTargetStatus::Idle.as_str(), "idle");
        assert_eq!(SyncTargetStatus::parse("ready"), SyncTargetStatus::Ready);
        assert_eq!(SyncTargetStatus::parse("error"), SyncTargetStatus::Error);
    }

    #[test]
    fn content_version_is_names_only() {
        let a = content_version_for("t1", &["FOO".into(), "BAR".into()]);
        let b = content_version_for("t1", &["FOO".into(), "BAR".into()]);
        assert_eq!(a, b);
        assert!(a.starts_with("cv_"));
        let c = content_version_for("t1", &["FOO".into()]);
        assert_ne!(a, c);
    }
}
