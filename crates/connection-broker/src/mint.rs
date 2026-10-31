//! `POST /connections/{id}/mint` in the broker (ADR 0049): one entry point,
//! one arm per provider with a native mint path. GitHub mints an App
//! installation token; the aws family assumes a role with STS
//! (`aws_mint.rs`, ADR 0217). Every other provider is `unmintable`.

use chrono::Utc;
use opensesame_domain::OrganizationId;

use crate::{
    parse_materialization, store, BrokerError, ConnectionBroker, ConnectionStatus,
    DerivedMaterialization, EventKind, MaterializationPolicy, MintCaller, Result,
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
        self.mint_derived_token_for(
            organization_id,
            id,
            MintCaller::principal(actor),
            installation_id,
            None,
        )
        .await
    }

    /// [`ConnectionBroker::mint_derived_token`] for a caller whose recorded
    /// actor may differ from its principal ([`MintCaller`]), with a requested
    /// lifetime, which an AWS mint honours under its binding's cap (ADR 0217)
    /// and a GitHub mint ignores (GitHub fixes the installation token's hour).
    ///
    /// # Errors
    ///
    /// Returns an error when authorization, policy, credential, or provider minting fails.
    pub async fn mint_derived_token_for(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        caller: MintCaller<'_>,
        installation_id: Option<&str>,
        duration_seconds: Option<u32>,
    ) -> Result<DerivedMaterialization> {
        let actor = caller.actor;
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
                    aws: None,
                    receipt: None,
                })
            }
            // ADR 0217: STS AssumeRole over the sealed key pair, for the role
            // the connection's binding names. No binding, no mint path.
            provider if crate::aws_sts::is_mintable_provider(provider) => {
                self.mint_aws_sts(&row, subject, caller, duration_seconds)
                    .await
            }
            other => Err(BrokerError::Unmintable(other.to_string())),
        }
    }
}
