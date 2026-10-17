//! `POST /connections/{id}/mint` in the broker (ADR 0049), moved out of
//! `lib.rs` unchanged so that module stays inside its size budget (ADR 0093):
//! one entry point, one arm per provider with a native mint path.

use chrono::Utc;
use opensesame_domain::OrganizationId;

use crate::{
    parse_materialization, store, BrokerError, ConnectionBroker, ConnectionStatus,
    DerivedMaterialization, EventKind, MaterializationPolicy, Result,
};

impl ConnectionBroker {
    /// Mint a provider-native, short-lived, revocable derived token (ADR 0049).
    ///
    /// The sealed stored credential never moves and never leaves the broker: for
    /// GitHub the mint runs off the integration's sealed App signing material and
    /// GitHub issues the installation token itself. Fails closed in both
    /// directions — the policy defaults to deny, and a provider without a mint
    /// path is `unmintable` rather than approximate.
    /// # Errors
    ///
    /// Returns an error when authorization, policy, credential, or provider minting fails.
    pub async fn mint_derived_token(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        actor: &str,
        installation_id: Option<&str>,
    ) -> Result<DerivedMaterialization> {
        let mut row = self.row_in_org(organization_id, id).await?;
        if parse_materialization(&row.materialization) != MaterializationPolicy::DerivedShortLived {
            return Err(BrokerError::MaterializationDenied);
        }
        if row.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid("connection is revoked".into()));
        }
        let subject = row
            .owner_subject
            .clone()
            .unwrap_or_else(|| "operator".into());
        match row.provider_id.as_str() {
            "github" => {
                let provider = self
                    .resolve_provider(&row.organization_id, &row.provider_id)
                    .await?;
                let (integration_id, _, _, _, _) = self
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
                let material = self
                    .github_app_signing_material(organization_id, &row.integration_id)
                    .await?
                    .ok_or_else(|| {
                        BrokerError::Invalid(
                            "integration holds no GitHub App signing material".into(),
                        )
                    })?;
                let installation_id = installation_id
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        BrokerError::Invalid(
                            "installation_id is required to mint a GitHub App installation token"
                                .into(),
                        )
                    })?;
                if !installation_id.chars().all(|c| c.is_ascii_digit()) {
                    return Err(BrokerError::Invalid(
                        "installation_id must be the numeric id from the GitHub App installation"
                            .into(),
                    ));
                }
                let minted = crate::installation::mint_installation_token(
                    &self.http,
                    self.config.github_api_base(),
                    &material,
                    installation_id,
                )
                .await
                .map_err(|error| BrokerError::ExchangeFailed(error.to_string()))?;
                store::append_event(
                    &self.pool,
                    &row.id,
                    EventKind::Materialized,
                    Some(&format!(
                        "github_app_installation sub={subject} act={actor}"
                    )),
                )
                .await?;
                tracing::info!(connection_id = %row.id, provider_id = "github", "derived installation token minted");
                Ok(DerivedMaterialization {
                    connection_id: row.id.clone(),
                    provider_id: "github".into(),
                    kind: "github_app_installation".into(),
                    derived_token: minted.token,
                    expires_at: minted.expires_at.to_rfc3339(),
                    subject,
                    actor: actor.to_string(),
                    issued_at: Utc::now().to_rfc3339(),
                })
            }
            // ADR 0049 follow-up: STS GetSessionToken (or AssumeRole when the
            // connection carries a role ARN) over the sealed long-term keys,
            // sigv4-signed through the broker's HTTP client. Until that lands the
            // aws family fails closed with the same answer as any other provider
            // without a mint path.
            "aws" | "aws-kms" | "aws-ps" | "aws-bedrock" => {
                Err(BrokerError::Unmintable(row.provider_id.clone()))
            }
            other => Err(BrokerError::Unmintable(other.to_string())),
        }
    }
}
