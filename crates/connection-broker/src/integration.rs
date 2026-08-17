use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use opensesame_domain::OrganizationId;
use serde::Serialize;
use sqlx::Row;

use crate::catalog::Provider;
use crate::config::ProviderConfig;
use crate::configuration::{self, Configuration};
use crate::crypto::{self, SealedBlob};
use crate::{BrokerError, ConnectionBroker, Result};

const DEPLOYMENT_PREFIX: &str = "deployment:";

fn catalog_provider_visible(production: bool, provider_id: &str) -> bool {
    !production || provider_id != "mock"
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationSource {
    Organization,
    SharedDev,
    Deployment,
}

#[derive(Clone, Debug, Serialize)]
pub struct IntegrationView {
    pub id: String,
    pub key: String,
    pub provider_id: String,
    pub display_name: String,
    pub source: IntegrationSource,
    pub enabled: bool,
    pub configured: bool,
    pub callback_url: Option<String>,
    pub scopes: Vec<String>,
    pub client_id_hint: Option<String>,
    pub has_client_secret: bool,
    pub configured_fields: Vec<crate::model::ConfiguredFieldView>,
    /// GitHub App public page (`https://github.com/apps/…`), when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_app_html_url: Option<String>,
    pub connection_count: i64,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct CreateIntegration {
    pub key: String,
    pub provider_id: String,
    pub display_name: String,
    pub scopes: Vec<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub configuration: Configuration,
    pub created_by: String,
}

#[derive(Clone, Default)]
pub struct UpdateIntegration {
    pub key: Option<String>,
    pub display_name: Option<String>,
    pub enabled: Option<bool>,
    pub scopes: Option<Vec<String>>,
    pub client_id: Option<String>,
    /// Omitted preserves the stored secret. An empty value clears it.
    pub client_secret: Option<String>,
    pub configuration_set: Configuration,
    pub configuration_clear: Vec<String>,
}

#[derive(Clone, Debug)]
struct IntegrationRow {
    id: String,
    organization_id: String,
    key: String,
    provider_id: String,
    display_name: String,
    enabled: bool,
    scopes: Vec<String>,
    client_id: Option<String>,
    secret: Option<SealedBlob>,
    configuration: Option<SealedBlob>,
    configured_field_names: Vec<String>,
    created_by: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

fn text(value: String, field: &str) -> Result<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(BrokerError::Invalid(format!("{field} is required")));
    }
    if value.len() > 1024 {
        return Err(BrokerError::Invalid(format!("{field} exceeds 1024 bytes")));
    }
    Ok(value)
}

fn parse_time(raw: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(raw)
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or(DateTime::<Utc>::MIN_UTC)
}

fn row_from_sql(row: &sqlx::sqlite::SqliteRow) -> IntegrationRow {
    let ciphertext: Option<Vec<u8>> = row.get("client_secret_ciphertext");
    IntegrationRow {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        key: row.get("key"),
        provider_id: row.get("provider_id"),
        display_name: row.get("display_name"),
        enabled: row.get::<i64, _>("enabled") != 0,
        scopes: serde_json::from_str(&row.get::<String, _>("scopes")).unwrap_or_default(),
        client_id: row.get("client_id"),
        secret: ciphertext.map(|ciphertext| SealedBlob {
            ciphertext,
            nonce: row
                .get::<Option<Vec<u8>>, _>("client_secret_nonce")
                .unwrap_or_default(),
            aad_digest: row
                .get::<Option<String>, _>("client_secret_aad_digest")
                .unwrap_or_default(),
        }),
        configuration: row
            .get::<Option<Vec<u8>>, _>("configuration_ciphertext")
            .map(|ciphertext| SealedBlob {
                ciphertext,
                nonce: row
                    .get::<Option<Vec<u8>>, _>("configuration_nonce")
                    .unwrap_or_default(),
                aad_digest: row
                    .get::<Option<String>, _>("configuration_aad_digest")
                    .unwrap_or_default(),
            }),
        configured_field_names: serde_json::from_str(&row.get::<String, _>("configured_fields"))
            .unwrap_or_default(),
        created_by: row.get("created_by"),
        created_at: parse_time(&row.get::<String, _>("created_at")),
        updated_at: parse_time(&row.get::<String, _>("updated_at")),
    }
}

fn hint(client_id: &Option<String>) -> Option<String> {
    client_id.as_ref().map(|value| {
        let suffix: String = value
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("***{suffix}")
    })
}

fn configured(provider: &Provider, configuration: &Configuration, sealing_available: bool) -> bool {
    sealing_available
        && configuration::complete(provider.integration_configuration_fields(), configuration)
}

fn validate_scopes(provider: &Provider, scopes: &[String]) -> Result<()> {
    if scopes.len() > 128 || scopes.iter().any(|scope| scope.len() > 256) {
        return Err(BrokerError::Invalid("scopes exceed allowed size".into()));
    }
    if let Some(scope) = scopes.iter().find(|scope| {
        !provider
            .scopes
            .iter()
            .any(|known| known.name == scope.as_str())
    }) {
        return Err(BrokerError::Invalid(format!(
            "scope `{scope}` is not supported by provider `{}`",
            provider.id
        )));
    }
    Ok(())
}

impl ConnectionBroker {
    fn integration_configuration(&self, row: &IntegrationRow) -> Result<Configuration> {
        if let Some(sealed) = &row.configuration {
            let plaintext =
                crypto::open(self.sealing_key()?, &row.id, &row.organization_id, sealed)?;
            return serde_json::from_slice(&plaintext).map_err(BrokerError::from);
        }

        // Rows written before 0006 remain usable without a forced credential rotation.
        let mut configuration = BTreeMap::new();
        if let Some(client_id) = &row.client_id {
            configuration.insert("client_id".into(), client_id.clone());
        }
        if let Some(secret) = &row.secret {
            let value = String::from_utf8(crypto::open(
                self.sealing_key()?,
                &row.id,
                &row.organization_id,
                secret,
            )?)
            .map_err(|_| BrokerError::SealUnavailable("client secret is not UTF-8".into()))?;
            configuration.insert("client_secret".into(), value);
        }
        Ok(configuration)
    }

    fn seal_integration_configuration(
        &self,
        id: &str,
        organization_id: &str,
        configuration: &Configuration,
    ) -> Result<Option<SealedBlob>> {
        if configuration.is_empty() {
            return Ok(None);
        }
        Ok(Some(crypto::seal(
            self.sealing_key()?,
            id,
            organization_id,
            &serde_json::to_vec(configuration)?,
        )?))
    }

    pub(crate) async fn pinned_provider_config(
        &self,
        organization_id: &OrganizationId,
        provider_id: &str,
        integration_id: &str,
    ) -> Result<ProviderConfig> {
        if integration_id == format!("{DEPLOYMENT_PREFIX}{provider_id}") {
            return Ok(self.config.provider(provider_id));
        }
        let row = self
            .integration_row(organization_id, integration_id)
            .await?;
        if row.provider_id != provider_id {
            return Err(BrokerError::IntegrationNotFound);
        }
        let configuration = self.integration_configuration(&row)?;
        Ok(ProviderConfig {
            client_id: configuration.get("client_id").cloned(),
            client_secret: configuration.get("client_secret").cloned(),
            authorize_url: None,
            token_url: None,
        })
    }

    async fn integration_count(&self, organization_id: &str, id: &str) -> Result<i64> {
        Ok(sqlx::query("SELECT COUNT(*) AS n FROM connections WHERE organization_id = ? AND integration_id = ?")
            .bind(organization_id)
            .bind(id)
            .fetch_one(&self.pool)
            .await?
            .get("n"))
    }

    async fn integration_row(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<IntegrationRow> {
        let row = sqlx::query("SELECT * FROM integrations WHERE id = ? AND organization_id = ?")
            .bind(id)
            .bind(organization_id.to_string())
            .fetch_optional(&self.pool)
            .await?
            .ok_or(BrokerError::IntegrationNotFound)?;
        Ok(row_from_sql(&row))
    }

    async fn row_view(&self, row: IntegrationRow) -> Result<IntegrationView> {
        let provider = self.provider(&row.provider_id)?;
        let configuration = self.integration_configuration(&row)?;
        let configured_fields =
            configuration::views(provider.integration_configuration_fields(), &configuration);
        Ok(IntegrationView {
            id: row.id.clone(),
            key: row.key,
            provider_id: row.provider_id,
            display_name: row.display_name,
            source: IntegrationSource::Organization,
            enabled: row.enabled,
            configured: configured(provider, &configuration, self.config.key().is_some()),
            callback_url: provider
                .auth
                .is_oauth()
                .then(|| self.config.callback_url(&provider.id)),
            scopes: row.scopes,
            client_id_hint: configured_fields
                .iter()
                .find(|field| field.name == "client_id")
                .and_then(|field| field.hint.clone()),
            has_client_secret: configuration.contains_key("client_secret"),
            configured_fields,
            github_app_html_url: configuration
                .get("html_url")
                .cloned()
                .filter(|url| url.starts_with("https://github.com/apps/")),
            connection_count: self
                .integration_count(&row.organization_id, &row.id)
                .await?,
            created_by: row.created_by,
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
        })
    }

    fn deployment_view(&self, provider: &Provider) -> Option<IntegrationView> {
        if !self.config.missing_config(provider).is_empty() {
            return None;
        }
        let cfg = self.config.provider(&provider.id);
        let configuration = Configuration::from_iter(
            [
                ("client_id", cfg.client_id.as_ref()),
                ("client_secret", cfg.client_secret.as_ref()),
            ]
            .into_iter()
            .filter_map(|(name, value)| value.map(|value| (name.into(), value.clone()))),
        );
        Some(IntegrationView {
            id: format!("{DEPLOYMENT_PREFIX}{}", provider.id),
            key: format!("deployment-{}", provider.id),
            provider_id: provider.id.to_string(),
            display_name: format!("{} (deployment)", provider.display_name),
            source: if crate::flow::is_production_env() {
                IntegrationSource::Deployment
            } else {
                IntegrationSource::SharedDev
            },
            enabled: true,
            configured: true,
            callback_url: provider
                .auth
                .is_oauth()
                .then(|| self.config.callback_url(&provider.id)),
            scopes: provider.default_scopes(),
            client_id_hint: hint(&cfg.client_id),
            has_client_secret: cfg.client_secret.is_some(),
            configured_fields: configuration::views(
                provider.integration_configuration_fields(),
                &configuration,
            ),
            github_app_html_url: None,
            connection_count: 0,
            created_by: "deployment".into(),
            created_at: "1970-01-01T00:00:00+00:00".into(),
            updated_at: "1970-01-01T00:00:00+00:00".into(),
        })
    }

    pub async fn list_integrations(
        &self,
        organization_id: &OrganizationId,
    ) -> Result<Vec<IntegrationView>> {
        let rows = sqlx::query(
            "SELECT * FROM integrations WHERE organization_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        let mut views = Vec::new();
        let production = crate::flow::is_production_env();
        for row in rows {
            let row = row_from_sql(&row);
            if !catalog_provider_visible(production, &row.provider_id) {
                continue;
            }
            views.push(self.row_view(row).await?);
        }
        for provider in crate::catalog::all()? {
            if !catalog_provider_visible(production, &provider.id) {
                continue;
            }
            if let Some(mut view) = self.deployment_view(provider) {
                view.connection_count = self
                    .integration_count(&organization_id.to_string(), &view.id)
                    .await?;
                views.push(view);
            }
        }
        Ok(views)
    }

    pub async fn get_integration(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<IntegrationView> {
        self.list_integrations(organization_id)
            .await?
            .into_iter()
            .find(|integration| integration.id == id)
            .ok_or(BrokerError::IntegrationNotFound)
    }

    pub async fn create_integration(
        &self,
        organization_id: &OrganizationId,
        request: CreateIntegration,
    ) -> Result<IntegrationView> {
        let key = text(request.key, "key")?;
        let provider_id = text(request.provider_id, "provider_id")?;
        let display_name = text(request.display_name, "display_name")?;
        let provider = self.provider(&provider_id)?;
        let id = format!("integration_{}", uuid::Uuid::new_v4());
        let mut configuration = request.configuration;
        for (name, value) in [
            ("client_id", request.client_id),
            ("client_secret", request.client_secret),
        ] {
            if let Some(value) = value {
                let value = if name == "client_id" {
                    value.trim().to_string()
                } else {
                    value
                };
                if value.is_empty() {
                    continue;
                }
                if configuration.insert(name.into(), value).is_some() {
                    return Err(BrokerError::Invalid(format!(
                        "configuration field `{name}` was supplied twice"
                    )));
                }
            }
        }
        configuration::validate_mutation(
            provider.integration_configuration_fields(),
            &configuration,
            &[],
        )?;
        let organization_id_string = organization_id.to_string();
        let sealed =
            self.seal_integration_configuration(&id, &organization_id_string, &configuration)?;
        let configured_field_names: Vec<_> = configuration.keys().cloned().collect();
        let scopes = if request.scopes.is_empty() {
            provider.default_scopes()
        } else {
            request.scopes
        };
        validate_scopes(provider, &scopes)?;
        let now = Utc::now();
        let inserted = sqlx::query(
            "INSERT INTO integrations (id, organization_id, key, provider_id, display_name, enabled, scopes, client_id, client_secret_ciphertext, client_secret_nonce, client_secret_aad_digest, configuration_ciphertext, configuration_nonce, configuration_aad_digest, configured_fields, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&organization_id_string)
        .bind(&key)
        .bind(&provider_id)
        .bind(&display_name)
        .bind(serde_json::to_string(&scopes)?)
        .bind(sealed.as_ref().map(|s| &s.ciphertext))
        .bind(sealed.as_ref().map(|s| &s.nonce))
        .bind(sealed.as_ref().map(|s| &s.aad_digest))
        .bind(serde_json::to_string(&configured_field_names)?)
        .bind(text(request.created_by, "created_by")?)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await;
        if let Err(error) = inserted {
            if error.to_string().contains("UNIQUE constraint failed") {
                return Err(BrokerError::IntegrationConflict);
            }
            return Err(error.into());
        }
        self.row_view(self.integration_row(organization_id, &id).await?)
            .await
    }

    /// Seal credentials from the GitHub App Manifest conversion as this
    /// organization's GitHub integration so Authorize can run without env vars.
    /// The App's private key and webhook secret are sealed alongside — they are
    /// what lets the backup actor mint installation tokens server-side and
    /// verify inbound webhooks (ADR 0039).
    pub async fn register_github_app_credentials(
        &self,
        organization_id: &OrganizationId,
        credentials: &crate::github_app::GithubAppCredentials,
        created_by: &str,
    ) -> Result<IntegrationView> {
        let key = format!("github-app-{}", credentials.id);
        let mut app_configuration: Configuration = BTreeMap::new();
        app_configuration.insert("app_id".into(), credentials.id.to_string());
        if let Some(pem) = &credentials.pem {
            app_configuration.insert("private_key_pem".into(), pem.clone());
        }
        if let Some(secret) = &credentials.webhook_secret {
            app_configuration.insert("webhook_secret".into(), secret.clone());
        }
        // Public App page URL — used by Pages to open Install (never a secret).
        if let Some(html_url) = credentials
            .html_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            app_configuration.insert("html_url".into(), html_url.to_string());
        }
        if let Some(existing) = self
            .list_integrations(organization_id)
            .await?
            .into_iter()
            .find(|integration| {
                integration.provider_id == "github"
                    && integration.key == key
                    && integration.source == IntegrationSource::Organization
            })
        {
            return self
                .update_integration(
                    organization_id,
                    &existing.id,
                    UpdateIntegration {
                        key: None,
                        display_name: Some(credentials.name.clone()),
                        enabled: Some(true),
                        scopes: Some(crate::github_app::history_integration_scopes()),
                        client_id: Some(credentials.client_id.clone()),
                        client_secret: Some(credentials.client_secret.clone()),
                        configuration_set: app_configuration,
                        configuration_clear: Vec::new(),
                    },
                )
                .await;
        }
        self.create_integration(
            organization_id,
            CreateIntegration {
                key,
                provider_id: "github".into(),
                display_name: credentials.name.clone(),
                scopes: crate::github_app::history_integration_scopes(),
                client_id: Some(credentials.client_id.clone()),
                client_secret: Some(credentials.client_secret.clone()),
                configuration: app_configuration,
                created_by: created_by.to_string(),
            },
        )
        .await
    }

    /// Unseal the GitHub App signing material for server-side installation
    /// token minting. Never crosses the API boundary; the backup actor is the
    /// only caller.
    pub async fn github_app_signing_material(
        &self,
        organization_id: &OrganizationId,
        integration_id: &str,
    ) -> Result<Option<crate::installation::GithubAppSigningMaterial>> {
        let row = self.integration_row(organization_id, integration_id).await?;
        let configuration = self.integration_configuration(&row)?;
        let (Some(app_id), Some(pem)) = (
            configuration.get("app_id"),
            configuration.get("private_key_pem"),
        ) else {
            return Ok(None);
        };
        Ok(Some(crate::installation::GithubAppSigningMaterial {
            app_id: app_id.clone(),
            private_key_pem: pem.clone(),
        }))
    }

    /// List GitHub App installations for backup/setup UX (ids + account login only).
    pub async fn list_github_app_installations(
        &self,
        organization_id: &OrganizationId,
        integration_id: &str,
    ) -> Result<Vec<crate::installation::GithubInstallationSummary>> {
        let Some(material) = self
            .github_app_signing_material(organization_id, integration_id)
            .await?
        else {
            return Err(BrokerError::Invalid(
                "integration holds no GitHub App signing material".into(),
            ));
        };
        crate::installation::list_app_installations(
            &self.http,
            crate::installation::DEFAULT_GITHUB_API_BASE,
            &material,
        )
        .await
        .map_err(|e| BrokerError::Invalid(e.to_string()))
    }

    pub async fn update_integration(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        request: UpdateIntegration,
    ) -> Result<IntegrationView> {
        if id.starts_with(DEPLOYMENT_PREFIX) {
            return Err(BrokerError::IntegrationReadOnly);
        }
        let mut configuration_set = request.configuration_set;
        let mut configuration_clear = request.configuration_clear;
        for (name, value) in [
            ("client_id", request.client_id),
            ("client_secret", request.client_secret),
        ] {
            if let Some(value) = value {
                let value = if name == "client_id" {
                    value.trim().to_string()
                } else {
                    value
                };
                if value.is_empty() {
                    configuration_clear.push(name.into());
                } else if configuration_set.insert(name.into(), value).is_some() {
                    return Err(BrokerError::Invalid(format!(
                        "configuration field `{name}` was supplied twice"
                    )));
                }
            }
        }
        let configuration_changed =
            !configuration_set.is_empty() || !configuration_clear.is_empty();
        let mut transaction = self.pool.begin().await?;
        // ponytail: SQLite has one writer. Taking that lock before the read makes partial
        // PATCHes serialize so one writer cannot restore another writer's old
        // fields. Revisit with row-version CAS when the store gains Postgres.
        let found = sqlx::query(
            "UPDATE integrations SET updated_at = updated_at WHERE id = ? AND organization_id = ?",
        )
        .bind(id)
        .bind(organization_id.to_string())
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1;
        if !found {
            return Err(BrokerError::IntegrationNotFound);
        }
        let mut row = row_from_sql(
            &sqlx::query("SELECT * FROM integrations WHERE id = ? AND organization_id = ?")
                .bind(id)
                .bind(organization_id.to_string())
                .fetch_one(&mut *transaction)
                .await?,
        );
        if let Some(key) = request.key {
            row.key = text(key, "key")?;
        }
        if let Some(name) = request.display_name {
            row.display_name = text(name, "display_name")?;
        }
        if let Some(enabled) = request.enabled {
            row.enabled = enabled;
        }
        if let Some(scopes) = request.scopes {
            validate_scopes(self.provider(&row.provider_id)?, &scopes)?;
            row.scopes = scopes;
        }
        if configuration_changed {
            let provider = self.provider(&row.provider_id)?;
            configuration::validate_mutation(
                provider.integration_configuration_fields(),
                &configuration_set,
                &configuration_clear,
            )?;
            let mut configuration = self.integration_configuration(&row)?;
            configuration::apply(&mut configuration, configuration_set, &configuration_clear);
            configuration::validate_mutation(
                provider.integration_configuration_fields(),
                &configuration,
                &[],
            )?;
            row.configuration =
                self.seal_integration_configuration(&row.id, &row.organization_id, &configuration)?;
            row.client_id = None;
            row.secret = None;
            row.configured_field_names = configuration.keys().cloned().collect();
        }
        row.updated_at = Utc::now();
        let updated = sqlx::query("UPDATE integrations SET key = ?, display_name = ?, enabled = ?, scopes = ?, client_id = ?, client_secret_ciphertext = ?, client_secret_nonce = ?, client_secret_aad_digest = ?, configuration_ciphertext = ?, configuration_nonce = ?, configuration_aad_digest = ?, configured_fields = ?, updated_at = ? WHERE id = ? AND organization_id = ?")
            .bind(&row.key)
            .bind(&row.display_name)
            .bind(i64::from(row.enabled))
            .bind(serde_json::to_string(&row.scopes)?)
            .bind(&row.client_id)
            .bind(row.secret.as_ref().map(|s| &s.ciphertext))
            .bind(row.secret.as_ref().map(|s| &s.nonce))
            .bind(row.secret.as_ref().map(|s| &s.aad_digest))
            .bind(row.configuration.as_ref().map(|s| &s.ciphertext))
            .bind(row.configuration.as_ref().map(|s| &s.nonce))
            .bind(row.configuration.as_ref().map(|s| &s.aad_digest))
            .bind(serde_json::to_string(&row.configured_field_names)?)
            .bind(row.updated_at.to_rfc3339())
            .bind(&row.id)
            .bind(&row.organization_id)
            .execute(&mut *transaction)
            .await;
        if let Err(error) = updated {
            if error.to_string().contains("UNIQUE constraint failed") {
                return Err(BrokerError::IntegrationConflict);
            }
            return Err(error.into());
        }
        transaction.commit().await?;
        self.row_view(row).await
    }

    pub async fn delete_integration(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<()> {
        if id.starts_with(DEPLOYMENT_PREFIX) {
            return Err(BrokerError::IntegrationReadOnly);
        }
        self.integration_row(organization_id, id).await?;
        if self
            .integration_count(&organization_id.to_string(), id)
            .await?
            != 0
        {
            return Err(BrokerError::IntegrationInUse);
        }
        let deleted = sqlx::query("DELETE FROM integrations WHERE id = ? AND organization_id = ?")
            .bind(id)
            .bind(organization_id.to_string())
            .execute(&self.pool)
            .await;
        if let Err(error) = deleted {
            if error.to_string().contains("integration_in_use") {
                return Err(BrokerError::IntegrationInUse);
            }
            return Err(error.into());
        }
        Ok(())
    }

    pub(crate) async fn resolve_integration(
        &self,
        organization_id: &OrganizationId,
        provider_id: Option<&str>,
        requested_id: Option<&str>,
    ) -> Result<(String, String, ProviderConfig, Vec<String>, Option<String>)> {
        let candidates = self.list_integrations(organization_id).await?;
        let configured_candidates: Vec<_> = candidates
            .into_iter()
            .filter(|i| provider_id.is_none_or(|provider| i.provider_id == provider))
            .filter(|i| i.enabled && i.configured)
            .collect();
        // A connection may still carry `deployment:github` from the PAT /
        // unconfigured-env path. Once a tenant GitHub App is sealed, OAuth must
        // prefer that org integration instead of failing on missing env vars.
        let candidates: Vec<_> = if let Some(requested) = requested_id {
            let exact: Vec<_> = configured_candidates
                .iter()
                .filter(|i| i.id == requested)
                .cloned()
                .collect();
            if !exact.is_empty() {
                exact
            } else if requested.starts_with(DEPLOYMENT_PREFIX) {
                configured_candidates
            } else {
                Vec::new()
            }
        } else {
            configured_candidates
        };
        let view = match candidates.as_slice() {
            [only] => only,
            [] => {
                // GitHub/GitLab history can seal a personal access token without an
                // OAuth App. Still refuse when there is no sealing key — we would
                // create a row we could never activate.
                if let Some(provider_id) = provider_id.filter(|id| {
                    crate::accepts_pasted_access_token(id) && self.config.key().is_some()
                }) {
                    let provider = self.provider(provider_id)?;
                    let scopes: Vec<String> = provider
                        .scopes
                        .iter()
                        .map(|scope| scope.name.to_string())
                        .collect();
                    return Ok((
                        format!("{DEPLOYMENT_PREFIX}{provider_id}"),
                        provider_id.to_string(),
                        ProviderConfig::default(),
                        scopes,
                        None,
                    ));
                }
                return Err(BrokerError::IntegrationNotFound);
            }
            _ => return Err(BrokerError::IntegrationRequired),
        };
        if view.source != IntegrationSource::Organization {
            return Ok((
                view.id.clone(),
                view.provider_id.clone(),
                self.config.provider(&view.provider_id),
                view.scopes.clone(),
                None,
            ));
        }
        let row = self.integration_row(organization_id, &view.id).await?;
        let provider = self.provider(&row.provider_id)?;
        let configuration = self.integration_configuration(&row)?;
        if !row.enabled
            || provider_id.is_some_and(|requested| requested != row.provider_id)
            || !configured(provider, &configuration, self.config.key().is_some())
        {
            return Err(BrokerError::IntegrationNotFound);
        }
        let updated_at = row.updated_at.to_rfc3339();
        let deployment = self.config.provider(&provider.id);
        Ok((
            row.id,
            row.provider_id,
            ProviderConfig {
                client_id: configuration.get("client_id").cloned(),
                client_secret: configuration.get("client_secret").cloned(),
                // Endpoint selection remains deployment-controlled. Organization
                // integrations replace credentials only; they cannot redirect
                // authorization codes or tokens to arbitrary hosts.
                authorize_url: deployment.authorize_url,
                token_url: deployment.token_url,
            },
            row.scopes,
            Some(updated_at),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::catalog_provider_visible;

    #[test]
    fn production_filters_stale_mock_rows_without_hiding_real_providers() {
        let providers = ["github", "mock", "stripe"];
        let visible: Vec<_> = providers
            .into_iter()
            .filter(|provider| catalog_provider_visible(true, provider))
            .collect();
        assert_eq!(visible, ["github", "stripe"]);
        assert!(providers
            .into_iter()
            .all(|provider| catalog_provider_visible(false, provider)));
    }
}
