//! The broker's side of the AWS mint (ADR 0217): assume the bound role with
//! STS and hand back the temporary credential STS issued.
//!
//! The source key pair never leaves this path: it is never returned, logged or
//! written into an event. A refusal is recorded as an `error` event carrying
//! only its stable code; a mint's receipt is `aws_receipt.rs`'s.

use chrono::{SecondsFormat, Utc};
use secrecy::ExposeSecret;

use crate::aws_sts::binding::AwsStsBinding;
use crate::aws_sts::signer::{SigV4Signer, SourceCredential};
use crate::aws_sts::{client, endpoint, request, AwsSessionCredentials, MintReceipt};
use crate::store::{self, ConnectionRow};
use crate::{BrokerError, ConnectionBroker, DerivedMaterialization, EventKind, MintCaller, Result};

/// The connection event kind's detail tag for an STS mint.
pub const KIND: &str = "aws_sts_assume_role";

impl ConnectionBroker {
    /// Assume the bound role and hand back STS's temporary credential. STS
    /// hears the caller's principal; the receipt and event record its actor.
    pub(crate) async fn mint_aws_sts(
        &self,
        row: &ConnectionRow,
        subject: String,
        caller: MintCaller<'_>,
        duration_seconds: Option<u32>,
    ) -> Result<DerivedMaterialization> {
        let actor = caller.actor;
        let binding = self
            .open_binding(row)
            .await?
            .ok_or_else(|| BrokerError::Unmintable(row.provider_id.clone()))?;
        let grant_id = uuid::Uuid::now_v7().simple().to_string();
        let request = assume_request(&binding, &grant_id, caller.principal, duration_seconds)?;
        let endpoint = endpoint::endpoint(&binding.region, self.config.aws_sts_endpoint())
            .ok_or_else(|| {
                BrokerError::Invalid("the binding's region has no STS endpoint".into())
            })?;
        let signer = SigV4Signer::new(self.source_credential(row).await?, binding.region.clone());
        let now = Utc::now();
        let invoker = client::invoker_for(&endpoint);
        let assumed = match client::assume_role(&invoker, &endpoint, &signer, &request, now).await {
            Ok(assumed) => assumed,
            Err(failure) => {
                tracing::warn!(connection_id = %row.id, code = failure.code(), "aws sts mint refused");
                store::append_event(&self.pool, &row.id, EventKind::Error, Some(failure.code()))
                    .await?;
                return Err(BrokerError::AwsSts(failure));
            }
        };
        drop(signer);
        let expires_at = assumed
            .credentials
            .expiration
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let receipt = MintReceipt {
            grant_id,
            role_arn: request.role_arn.clone(),
            role_session_name: request.role_session_name.clone(),
            source_identity: request.source_identity.clone(),
            duration_seconds: request.duration_seconds,
            expires_at: expires_at.clone(),
            request_id: assumed.request_id.clone(),
        };
        self.record_aws_mint(
            row,
            &receipt,
            &subject,
            actor,
            assumed.credentials.expiration,
            now,
        )
        .await?;
        let credentials = assumed.credentials;
        Ok(DerivedMaterialization {
            connection_id: row.id.clone(),
            provider_id: row.provider_id.clone(),
            kind: KIND.into(),
            derived_token: credentials.session_token.expose_secret().to_string(),
            expires_at,
            subject,
            actor: actor.to_string(),
            issued_at: now.to_rfc3339_opts(SecondsFormat::Secs, true),
            aws: Some(AwsSessionCredentials {
                access_key_id: credentials.access_key_id,
                secret_access_key: credentials.secret_access_key,
                session_token: credentials.session_token,
            }),
            receipt: Some(receipt),
        })
    }

    /// The source key pair, opened from the sealed configuration.
    async fn source_credential(&self, row: &ConnectionRow) -> Result<SourceCredential> {
        let credential = store::get_credential(&self.pool, &row.id)
            .await?
            .ok_or_else(|| BrokerError::NeedsReauth("the connection holds no AWS key".into()))?;
        let tokens = Self::open_tokens(self.sealing_key()?, row, &credential)?;
        SourceCredential::from_configuration(&tokens.configuration)
            .ok_or_else(|| BrokerError::NeedsReauth("the connection holds no AWS key pair".into()))
    }
}

/// The `AssumeRole` one mint sends: the binding's role, policy and
/// `ExternalId`, a session name from the grant id, the caller's principal as
/// `SourceIdentity`, and a duration inside the binding's cap.
fn assume_request(
    binding: &AwsStsBinding,
    grant_id: &str,
    principal: &str,
    duration_seconds: Option<u32>,
) -> Result<request::AssumeRoleRequest> {
    Ok(request::AssumeRoleRequest {
        role_arn: binding.role_arn.clone(),
        role_session_name: request::session_name(grant_id)
            .map_err(|why| BrokerError::Invalid(why.into()))?,
        duration_seconds: request::duration_for(duration_seconds, binding.max_duration_seconds)
            .map_err(|why| BrokerError::Invalid(why.into()))?,
        policy: binding.session_policy.clone(),
        source_identity: request::source_identity(principal),
        external_id: binding.external_id.clone(),
    })
}
