//! Request authority is checked at materialization, not cached at dispatch.
use std::collections::BTreeMap;
use std::sync::Arc;

use opensesame_connection_broker::{
    config_access::{self, PolicyActor, ResourcePermission},
    BrokerError, SyncSecretSource,
};
use opensesame_domain::OrganizationId;
use sqlx::SqlitePool;

pub(super) struct CallerSecretSource {
    pool: SqlitePool,
    organization: OrganizationId,
    actor: PolicyActor,
    inner: Arc<dyn SyncSecretSource>,
}

impl CallerSecretSource {
    pub(super) fn new(
        pool: SqlitePool,
        organization: OrganizationId,
        actor: PolicyActor,
        inner: Arc<dyn SyncSecretSource>,
    ) -> Self {
        Self {
            pool,
            organization,
            actor,
            inner,
        }
    }

    async fn check(&self, organization: &str, project: &str) -> Result<(), BrokerError> {
        if organization != self.organization.to_string() {
            return Err(BrokerError::ConfigNotFound);
        }
        match config_access::permits(
            &self.pool,
            &self.organization,
            &self.actor,
            project,
            ResourcePermission::Keys,
        )
        .await
        {
            Ok(true) => Ok(()),
            Ok(false) => Err(BrokerError::ConfigNotFound),
            Err(_) => Err(BrokerError::Storage(sqlx::Error::Protocol(
                "sync authorization lookup failed".into(),
            ))),
        }
    }
}

#[async_trait::async_trait]
impl SyncSecretSource for CallerSecretSource {
    async fn load_config_secrets(
        &self,
        organization_id: &str,
        project_id: &str,
        config_id: &str,
    ) -> Result<BTreeMap<String, String>, BrokerError> {
        self.check(organization_id, project_id).await?;
        let entries = self
            .inner
            .load_config_secrets(organization_id, project_id, config_id)
            .await?;
        // A revocation during the load must prevent the loaded snapshot from
        // reaching the broker's egress path. Every fan-out invocation repeats
        // both checks; the wrapper contains identity, never a cached allow.
        self.check(organization_id, project_id).await?;
        Ok(entries)
    }
}

#[cfg(test)]
#[path = "sync_targets_background_tests.rs"]
mod background_tests;
