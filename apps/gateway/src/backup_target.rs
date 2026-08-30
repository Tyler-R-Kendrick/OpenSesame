//! Snapshot delivery targets (ADR 0061 §6).
//!
//! The saga in `backup.rs` stays target-agnostic: it claims events, builds
//! the ciphertext snapshot, and hands the files to a [`SnapshotTarget`].
//! A closed enum rather than a trait object: target kinds are a reviewed
//! platform decision (`github_app` | `connector`), and community
//! pluggability lives *inside* the connector kind — any provider whose Host
//! connection can carry authorized uploads can receive snapshots, with the
//! credential injected by the broker and never present here.
//!
//! Everything delivered is ciphertext by construction (`snapshot()` reads
//! sealed bytes only), so the worst a hostile target can do is refuse or
//! retain ciphertext it cannot open.

use opensesame_connection_broker::ConnectionBroker;
use opensesame_domain::OrganizationId;
use opensesame_storage::BackupTarget;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::backup::{CommitOutcome, SnapshotFile, StepError};

pub const KIND_GITHUB_APP: &str = "github_app";
pub const KIND_CONNECTOR: &str = "connector";

/// Connector-kind delivery: one authorized upload per snapshot file, then a
/// manifest, all through `ConnectionBroker::authorized_bytes` — the single
/// credential-injection funnel, which re-checks the connection's egress
/// binding on every request.
pub struct ConnectorSnapshotTarget {
    pub broker: Arc<ConnectionBroker>,
    pub organization: OrganizationId,
    pub connection_id: String,
    pub base_url: String,
}

impl ConnectorSnapshotTarget {
    /// Build from a `kind='connector'` row. Fail-closed on missing routing.
    ///
    /// # Errors
    ///
    /// Returns `StepError::Suspend` when the row lacks the connection or a
    /// usable `base_url` — retrying cannot fix configuration.
    pub fn from_row(
        broker: Arc<ConnectionBroker>,
        organization: OrganizationId,
        target: &BackupTarget,
    ) -> Result<Self, StepError> {
        let connection_id = target
            .connection_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                StepError::Suspend("connector backup target has no connection_id".into())
            })?
            .to_owned();
        let config: serde_json::Value = target
            .config
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| StepError::Suspend("connector backup target config is not JSON".into()))?
            .unwrap_or_default();
        let base_url = config
            .get("base_url")
            .and_then(|v| v.as_str())
            .filter(|u| u.starts_with("https://"))
            .ok_or_else(|| {
                StepError::Suspend("connector backup target config lacks an https base_url".into())
            })?
            .trim_end_matches('/')
            .to_owned();
        Ok(Self {
            broker,
            organization,
            connection_id,
            base_url,
        })
    }

    fn file_url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path)
    }

    /// Deliver every file, then a manifest naming each path and content
    /// digest. Returns a synthetic commit id — the manifest digest — so the
    /// status row shows *which* snapshot landed.
    ///
    /// # Errors
    ///
    /// `NeedsReauth`-class broker failures suspend (a human must reauthorize
    /// the connection); everything else retries with backoff.
    pub async fn commit_snapshot(
        &self,
        files: &[SnapshotFile],
        message: &str,
    ) -> Result<CommitOutcome, StepError> {
        let mut manifest_entries = Vec::with_capacity(files.len());
        for file in files {
            let url = self.file_url(&file.path);
            self.broker
                .authorized_bytes(
                    &self.organization,
                    &self.connection_id,
                    &url,
                    &[],
                    file.content.clone().into_bytes(),
                )
                .await
                .map_err(map_broker_error)?;
            manifest_entries.push(serde_json::json!({
                "path": file.path,
                "sha256": format!("{:x}", Sha256::digest(file.content.as_bytes())),
            }));
        }
        let manifest = serde_json::json!({
            "message": message,
            "files": manifest_entries,
        });
        let manifest_bytes = serde_json::to_vec(&manifest)
            .map_err(|e| StepError::Retry(format!("manifest encode: {e}")))?;
        let manifest_digest = format!("sha256:{:x}", Sha256::digest(&manifest_bytes));
        self.broker
            .authorized_bytes(
                &self.organization,
                &self.connection_id,
                &self.file_url("opensesame-backup-manifest.json"),
                &[],
                manifest_bytes,
            )
            .await
            .map_err(map_broker_error)?;
        Ok(CommitOutcome::Committed(manifest_digest))
    }
}

fn map_broker_error(error: opensesame_connection_broker::BrokerError) -> StepError {
    match &error {
        opensesame_connection_broker::BrokerError::NeedsReauth(reason) => {
            StepError::Suspend(format!("connection needs reauthorization: {reason}"))
        }
        _ => StepError::Retry(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(connection_id: Option<&str>, config: Option<&str>) -> BackupTarget {
        BackupTarget {
            organization_id: "org".into(),
            integration_id: String::new(),
            installation_id: String::new(),
            owner: String::new(),
            repo: String::new(),
            branch: String::new(),
            enabled: true,
            status: "ok".into(),
            last_commit_sha: None,
            last_synced_at: None,
            last_error: None,
            kind: KIND_CONNECTOR.into(),
            provider_id: Some("encrypted-remote".into()),
            connection_id: connection_id.map(str::to_owned),
            config: config.map(str::to_owned),
        }
    }

    fn broker_less(target: &BackupTarget) -> Result<(), StepError> {
        // from_row needs a broker only to store it; validation happens first,
        // so a panic-free probe is enough here. Use a dangling Arc via a
        // deliberately unreachable code path: instead validate by calling
        // from_row with a broker built from an in-memory pool is heavy, so we
        // validate the two fail-closed branches through the returned error.
        let broker = test_broker();
        ConnectorSnapshotTarget::from_row(
            broker,
            OrganizationId::from_uuid(uuid::Uuid::nil()),
            target,
        )
        .map(|_| ())
    }

    fn test_broker() -> Arc<ConnectionBroker> {
        // A lazily-connected broker over an in-memory pool; never queried by
        // from_row.
        static BROKER: std::sync::OnceLock<Arc<ConnectionBroker>> = std::sync::OnceLock::new();
        BROKER
            .get_or_init(|| {
                let pool = sqlx::SqlitePool::connect_lazy("sqlite::memory:").expect("pool");
                Arc::new(
                    ConnectionBroker::new(
                        pool,
                        opensesame_connection_broker::BrokerConfig::in_memory(
                            None,
                            "http://127.0.0.1:8787",
                        ),
                    )
                    .expect("broker"),
                )
            })
            .clone()
    }

    #[tokio::test]
    async fn from_row_fails_closed_on_missing_routing() {
        assert!(matches!(
            broker_less(&row(None, Some(r#"{"base_url":"https://files.example"}"#))),
            Err(StepError::Suspend(_))
        ));
        assert!(matches!(
            broker_less(&row(Some("con_1"), None)),
            Err(StepError::Suspend(_))
        ));
        assert!(matches!(
            broker_less(&row(
                Some("con_1"),
                Some(r#"{"base_url":"http://plain.example"}"#)
            )),
            Err(StepError::Suspend(_))
        ));
        assert!(broker_less(&row(
            Some("con_1"),
            Some(r#"{"base_url":"https://files.example/backup/"}"#)
        ))
        .is_ok());
    }

    #[tokio::test]
    async fn file_urls_join_under_the_base() {
        let target = ConnectorSnapshotTarget {
            broker: test_broker(),
            organization: OrganizationId::from_uuid(uuid::Uuid::nil()),
            connection_id: "con_1".into(),
            base_url: "https://files.example/backup".into(),
        };
        assert_eq!(
            target.file_url("README.md"),
            "https://files.example/backup/README.md"
        );
    }
}
