//! The STS binding an operator writes on an aws-family connection (ADR 0217),
//! and its custody.
//!
//! The binding is sealed whole under the connection key with its own
//! associated data; only its value-blind view leaves the broker.

use opensesame_domain::OrganizationId;
use zeroize::Zeroizing;

use crate::aws_sts::binding::{AwsStsBinding, AwsStsBindingInput, AwsStsBindingView};
use crate::aws_sts::is_mintable_provider;
use crate::aws_sts::store as sts_store;
use crate::store::{self, ConnectionRow};
use crate::{BrokerError, ConnectionBroker, EventKind, Result};

impl ConnectionBroker {
    /// Bind (or rebind) the STS role an aws-family connection mints for.
    ///
    /// # Errors
    ///
    /// `Invalid` for a connection outside the aws family or an input the
    /// binding refuses; storage and sealing failures.
    pub async fn put_aws_sts_binding(
        &self,
        organization_id: &OrganizationId,
        id: &str,
        input: AwsStsBindingInput,
    ) -> Result<AwsStsBindingView> {
        let row = self.row_in_org(organization_id, id).await?;
        if !is_mintable_provider(&row.provider_id) {
            return Err(BrokerError::Invalid(
                "only an aws-family connection can carry an STS binding".into(),
            ));
        }
        let binding =
            AwsStsBinding::from_input(input).map_err(|why| BrokerError::Invalid(why.into()))?;
        let plaintext = Zeroizing::new(serde_json::to_vec(&binding)?);
        sts_store::put_binding(
            &self.pool,
            self.sealing_key()?,
            &row.id,
            &row.organization_id,
            &plaintext,
        )
        .await?;
        store::append_event(
            &self.pool,
            &row.id,
            EventKind::PolicyUpdated,
            Some("aws_sts_binding set"),
        )
        .await?;
        Ok(binding.view())
    }

    /// The binding's value-blind view, when the connection has one.
    ///
    /// # Errors
    ///
    /// Storage failures, or a binding whose seal does not open.
    pub async fn aws_sts_binding(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<Option<AwsStsBindingView>> {
        let row = self.row_in_org(organization_id, id).await?;
        Ok(self.open_binding(&row).await?.map(|binding| binding.view()))
    }

    /// Remove the binding; the connection can no longer mint.
    ///
    /// # Errors
    ///
    /// `BindingNotFound` when there was none; storage failures.
    pub async fn delete_aws_sts_binding(
        &self,
        organization_id: &OrganizationId,
        id: &str,
    ) -> Result<()> {
        let row = self.row_in_org(organization_id, id).await?;
        if !sts_store::delete_binding(&self.pool, &row.id, &row.organization_id).await? {
            return Err(BrokerError::BindingNotFound);
        }
        store::append_event(
            &self.pool,
            &row.id,
            EventKind::PolicyUpdated,
            Some("aws_sts_binding removed"),
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn open_binding(&self, row: &ConnectionRow) -> Result<Option<AwsStsBinding>> {
        let Some(blob) =
            sts_store::sealed_binding(&self.pool, &row.id, &row.organization_id).await?
        else {
            return Ok(None);
        };
        let plaintext =
            sts_store::open_binding(self.sealing_key()?, &row.id, &row.organization_id, &blob)?;
        let plaintext = Zeroizing::new(plaintext);
        Ok(Some(serde_json::from_slice(&plaintext)?))
    }
}
