//! Event-driven GitHub backup actor (ADR 0039).
//!
//! Secret mutations broadcast change events into the transactional outbox;
//! this actor drains them and persists a full ciphertext snapshot to the
//! organization's backup repository, authenticating as the org-installed
//! GitHub App. No CLI, no human in the loop.
//!
//! The workflow is a saga. Every step before the ref update is free of
//! external side effects (orphaned git objects are inert), so compensation is
//! always one of: release the claim and retry with backoff (transient
//! failure), rebuild against the moved head (lost ref race), suspend the
//! target and park the events (installation revoked), or dead-letter a poison
//! batch — which stays safe because each commit is a *complete* snapshot of
//! current state, so any later success reconciles everything a dropped event
//! described.

use std::time::Duration;

use base64::Engine as _;
use opensesame_connection_broker::installation::{
    mint_installation_token, GithubAppSigningMaterial, InstallationToken, MintError,
};
use opensesame_connection_broker::store as broker_store;
use opensesame_storage::BackupTarget;
use serde_json::json;

use crate::app_state::AppState;

const BATCH_LIMIT: i64 = 256;
const CLAIM_LEASE_SECONDS: i64 = 120;
/// After this many failed attempts an event is dead-lettered; the snapshot
/// model makes that safe (see module docs).
const MAX_ATTEMPTS: i64 = 8;
const SUSPENDED_BACKOFF_SECONDS: i64 = 600;

pub fn github_api_base() -> String {
    std::env::var("GITHUB_API_BASE")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://api.github.com".into())
}

fn tick_interval() -> Duration {
    std::env::var("OPENSESAME_BACKUP_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(5))
}

/// Run the actor until the process exits. Spawned once from `main`; the
/// `backup_notify` handle on [`AppState`] wakes it immediately after
/// configuration changes or explicit resync requests, the tick covers
/// everything else.
pub async fn run(state: AppState) {
    let api_base = github_api_base();
    let mut token_cache: Option<InstallationToken> = None;
    let interval = tick_interval();
    loop {
        tokio::select! {
            _ = state.backup_notify.notified() => {}
            _ = tokio::time::sleep(interval) => {}
        }
        if let Err(error) = pass(&state, &api_base, &mut token_cache).await {
            tracing::warn!(%error, "backup pass failed");
        }
    }
}

/// One drain-and-persist pass. Public for tests.
pub async fn pass(
    state: &AppState,
    api_base: &str,
    token_cache: &mut Option<InstallationToken>,
) -> anyhow::Result<()> {
    let events = state
        .db
        .claim_outbox_batch(BATCH_LIMIT, CLAIM_LEASE_SECONDS)
        .await?;
    if events.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = events.iter().map(|e| e.id.clone()).collect();
    let max_attempts = events.iter().map(|e| e.attempts).max().unwrap_or(0);

    let organization = state.connection_organization.to_string();
    let Some(target) = state.db.get_backup_target(&organization).await? else {
        // Nothing to persist into. Drain rather than queue forever: enabling a
        // target later triggers a full-snapshot resync that reconciles all of
        // this anyway.
        state
            .db
            .dead_letter_outbox(&ids, "no backup target configured")
            .await?;
        return Ok(());
    };
    if !target.enabled {
        state
            .db
            .dead_letter_outbox(&ids, "backup target disabled")
            .await?;
        return Ok(());
    }

    // Step 1: authenticate as the installed GitHub App.
    let token = match installation_token(state, &target, api_base, token_cache).await {
        Ok(token) => token,
        Err(StepError::Suspend(reason)) => {
            return compensate_suspend(state, &organization, &ids, &reason).await;
        }
        Err(StepError::Retry(reason)) => {
            return compensate_retry(state, &ids, max_attempts, &reason).await;
        }
    };

    // Step 2: build the ciphertext snapshot from current state. Events are
    // triggers, not sources of truth — this is what makes retries and
    // dead-letters convergent.
    let files = snapshot(state).await?;
    let event_summary = summarize(&events);

    // Step 3: commit the snapshot. Orphaned objects from a lost ref race cost
    // nothing; the compensation is to rebuild against the new head next pass.
    let github = GithubSnapshotClient {
        http: state.connection_broker.http_client().clone(),
        api_base: api_base.to_string(),
        token: token.token.clone(),
    };
    match github
        .commit_snapshot(&target, &files, &event_summary)
        .await
    {
        Ok(CommitOutcome::Committed(sha)) => {
            state.db.mark_outbox_published(&ids).await?;
            state
                .db
                .record_backup_outcome(&organization, "ok", Some(&sha), None)
                .await?;
            Ok(())
        }
        Ok(CommitOutcome::NoChanges) => {
            state.db.mark_outbox_published(&ids).await?;
            state
                .db
                .record_backup_outcome(&organization, "ok", None, None)
                .await?;
            Ok(())
        }
        Err(StepError::Suspend(reason)) => {
            *token_cache = None;
            compensate_suspend(state, &organization, &ids, &reason).await
        }
        Err(StepError::Retry(reason)) => compensate_retry(state, &ids, max_attempts, &reason).await,
    }
}

/// Compensation: the App or its installation is gone. Retrying cannot help, so
/// suspend the target (a human must reinstall/reconfigure), park the events
/// long enough not to spin, and keep everything replayable.
async fn compensate_suspend(
    state: &AppState,
    organization: &str,
    ids: &[String],
    reason: &str,
) -> anyhow::Result<()> {
    tracing::warn!(reason, "backup suspended");
    state
        .db
        .record_backup_outcome(organization, "suspended", None, Some(reason))
        .await?;
    state
        .db
        .park_outbox(ids, reason, SUSPENDED_BACKOFF_SECONDS)
        .await?;
    Ok(())
}

/// Compensation: transient failure. Release the claim with exponential
/// backoff; a batch that keeps failing is dead-lettered and reconciled by the
/// next successful full snapshot.
async fn compensate_retry(
    state: &AppState,
    ids: &[String],
    attempts: i64,
    reason: &str,
) -> anyhow::Result<()> {
    if attempts + 1 >= MAX_ATTEMPTS {
        tracing::warn!(
            reason,
            "backup batch dead-lettered after {MAX_ATTEMPTS} attempts"
        );
        state.db.dead_letter_outbox(ids, reason).await?;
        return Ok(());
    }
    let backoff = (5i64 << attempts.min(9)).min(3600);
    state.db.park_outbox(ids, reason, backoff).await?;
    Ok(())
}

enum StepError {
    /// Human intervention required (app uninstalled, key rotated, repo gone).
    Suspend(String),
    /// Worth retrying with backoff.
    Retry(String),
}

async fn installation_token(
    state: &AppState,
    target: &BackupTarget,
    api_base: &str,
    cache: &mut Option<InstallationToken>,
) -> Result<InstallationToken, StepError> {
    if let Some(token) = cache.as_ref().filter(|token| token.usable()) {
        return Ok(token.clone());
    }
    let signing: GithubAppSigningMaterial = state
        .connection_broker
        .github_app_signing_material(&state.connection_organization, &target.integration_id)
        .await
        .map_err(|e| StepError::Retry(format!("loading signing material: {e}")))?
        .ok_or_else(|| {
            StepError::Suspend(
                "integration holds no GitHub App signing material — re-register the app".into(),
            )
        })?;
    let minted = mint_installation_token(
        state.connection_broker.http_client(),
        api_base,
        &signing,
        &target.installation_id,
    )
    .await
    .map_err(|e| match e {
        MintError::Suspended(reason) => StepError::Suspend(reason),
        MintError::Transient(reason) => StepError::Retry(reason.to_string()),
    })?;
    *cache = Some(minted.clone());
    Ok(minted)
}

/// A snapshot file: repo-relative path plus UTF-8 content (ciphertext is
/// base64-wrapped in JSON, so the tree API's inline `content` form applies).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotFile {
    pub path: String,
    pub content: String,
}

/// Build the complete backup tree from current gateway state. Ciphertext only:
/// broker credentials stay sealed under the deployment key, sync blobs and
/// vault revisions are E2EE bytes the server never could read.
pub async fn snapshot(state: &AppState) -> anyhow::Result<Vec<SnapshotFile>> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let path_component =
        |value: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.as_bytes());
    let mut files = vec![SnapshotFile {
        path: "README.md".into(),
        content: "# OpenSesame backup store\n\nCiphertext snapshots written by the OpenSesame \
                  backup actor (ADR 0039). Every file is sealed; none of it can be read \
                  without keys that never enter this repository.\n"
            .into(),
    }];

    let credentials = broker_store::list_sealed_credentials(state.db.pool()).await?;
    for row in &credentials {
        files.push(SnapshotFile {
            path: format!("connections/{}.json", path_component(&row.connection_id)),
            content: serde_json::to_string_pretty(&json!({
                "connection_id": row.connection_id,
                "version": row.version,
                "sealed": {
                    "ciphertext_b64": b64.encode(&row.sealed.ciphertext),
                    "nonce_b64": b64.encode(&row.sealed.nonce),
                    "aad_digest": row.sealed.aad_digest,
                },
                "token_type": row.token_type,
                "expires_at": row.expires_at,
                "refreshable": row.refreshable,
            }))?,
        });
    }

    for (owner_id, blob) in state.db.list_all_sync_blobs().await? {
        files.push(SnapshotFile {
            path: format!(
                "sync/{}/{}.json",
                path_component(&owner_id),
                path_component(&blob.id)
            ),
            content: serde_json::to_string_pretty(&json!({
                "owner_id": owner_id,
                "blob_id": blob.id,
                "epoch": blob.epoch,
                "ciphertext_b64": b64.encode(&blob.ciphertext),
            }))?,
        });
    }

    for revision in state.db.list_encrypted_item_revisions().await? {
        files.push(SnapshotFile {
            path: format!(
                "vault/{}/{}/{}.json",
                path_component(&revision.vault_id),
                path_component(&revision.item_id),
                revision.revision
            ),
            content: serde_json::to_string_pretty(&json!({
                "vault_id": revision.vault_id,
                "item_id": revision.item_id,
                "ciphertext_b64": b64.encode(&revision.ciphertext),
                "wrapping": revision.wrapping_json,
                "ad_digest": revision.ad_digest,
            }))?,
        });
    }

    files.push(SnapshotFile {
        path: "manifest.json".into(),
        content: serde_json::to_string_pretty(&json!({
            "schema": 1,
            "connections": credentials.len(),
            "files": files.len(),
        }))?,
    });
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn summarize(events: &[opensesame_storage::OutboxEvent]) -> String {
    let mut kinds: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    kinds.sort_unstable();
    kinds.dedup();
    format!(
        "Backup snapshot: {} event{} ({})",
        events.len(),
        if events.len() == 1 { "" } else { "s" },
        kinds.join(", ")
    )
}

pub enum CommitOutcome {
    Committed(String),
    NoChanges,
}

/// Git Data API client for atomic snapshot commits: one tree, one commit, one
/// fast-forward ref update. Injecting `api_base` keeps it fully testable.
pub struct GithubSnapshotClient {
    pub http: reqwest::Client,
    pub api_base: String,
    pub token: String,
}

impl GithubSnapshotClient {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.api_base.trim_end_matches('/'))
    }

    async fn get_json(&self, path: &str) -> Result<(u16, serde_json::Value), StepError> {
        let response = self
            .http
            .get(self.url(path))
            .bearer_auth(&self.token)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "opensesame-gateway")
            .send()
            .await
            .map_err(|e| StepError::Retry(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response.json().await.unwrap_or(serde_json::Value::Null);
        Ok((status, body))
    }

    async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<(u16, serde_json::Value), StepError> {
        let response = self
            .http
            .request(method, self.url(path))
            .bearer_auth(&self.token)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "opensesame-gateway")
            .json(body)
            .send()
            .await
            .map_err(|e| StepError::Retry(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response.json().await.unwrap_or(serde_json::Value::Null);
        Ok((status, body))
    }

    async fn commit_snapshot(
        &self,
        target: &BackupTarget,
        files: &[SnapshotFile],
        message: &str,
    ) -> Result<CommitOutcome, StepError> {
        let owner = &target.owner;
        let repo = &target.repo;
        let branch = &target.branch;

        // Read the current head. 404 on the ref means an empty repository or a
        // branch we have not created yet — both are first-commit cases.
        let (status, head) = self
            .get_json(&format!("/repos/{owner}/{repo}/git/ref/heads/{branch}"))
            .await?;
        let parent = match status {
            200 => Some(
                head["object"]["sha"]
                    .as_str()
                    .ok_or_else(|| StepError::Retry("ref response missing sha".into()))?
                    .to_string(),
            ),
            404 => None,
            401 | 403 => {
                return Err(StepError::Suspend(format!(
                    "backup repository unreachable as the app installation ({status})"
                )))
            }
            other => return Err(StepError::Retry(format!("reading ref returned {other}"))),
        };

        // If the repository itself is gone, only a human can fix that.
        if parent.is_none() {
            let (repo_status, _) = self.get_json(&format!("/repos/{owner}/{repo}")).await?;
            if repo_status == 404 {
                return Err(StepError::Suspend(format!(
                    "backup repository {owner}/{repo} does not exist or the app cannot see it"
                )));
            }
        }

        // Full tree, inline contents: complete snapshot, so deletions in the
        // source are deletions in the repo without tracking them event by event.
        let tree_entries: Vec<serde_json::Value> = files
            .iter()
            .map(|file| {
                json!({"path": file.path, "mode": "100644", "type": "blob", "content": file.content})
            })
            .collect();
        let (status, tree) = self
            .send_json(
                reqwest::Method::POST,
                &format!("/repos/{owner}/{repo}/git/trees"),
                &json!({"tree": tree_entries}),
            )
            .await?;
        if status != 201 {
            return Err(StepError::Retry(format!("creating tree returned {status}")));
        }
        let tree_sha = tree["sha"]
            .as_str()
            .ok_or_else(|| StepError::Retry("tree response missing sha".into()))?;

        // Skip empty commits: identical snapshot means nothing changed.
        if let Some(parent_sha) = &parent {
            let (status, parent_commit) = self
                .get_json(&format!("/repos/{owner}/{repo}/git/commits/{parent_sha}"))
                .await?;
            if status == 200 && parent_commit["tree"]["sha"].as_str() == Some(tree_sha) {
                return Ok(CommitOutcome::NoChanges);
            }
        }

        let parents = parent
            .as_ref()
            .map(|sha| vec![sha.clone()])
            .unwrap_or_default();
        let (status, commit) = self
            .send_json(
                reqwest::Method::POST,
                &format!("/repos/{owner}/{repo}/git/commits"),
                &json!({"message": message, "tree": tree_sha, "parents": parents}),
            )
            .await?;
        if status != 201 {
            return Err(StepError::Retry(format!(
                "creating commit returned {status}"
            )));
        }
        let commit_sha = commit["sha"]
            .as_str()
            .ok_or_else(|| StepError::Retry("commit response missing sha".into()))?
            .to_string();

        // Fast-forward-only ref update is the atomic step. Losing the race
        // leaves only orphaned objects; the compensation is a rebuilt snapshot
        // against the new head on the next pass.
        let (status, _) = if parent.is_some() {
            self.send_json(
                reqwest::Method::PATCH,
                &format!("/repos/{owner}/{repo}/git/refs/heads/{branch}"),
                &json!({"sha": commit_sha, "force": false}),
            )
            .await?
        } else {
            self.send_json(
                reqwest::Method::POST,
                &format!("/repos/{owner}/{repo}/git/refs"),
                &json!({"ref": format!("refs/heads/{branch}"), "sha": commit_sha}),
            )
            .await?
        };
        match status {
            200 | 201 => Ok(CommitOutcome::Committed(commit_sha)),
            409 | 422 => Err(StepError::Retry(
                "ref moved during snapshot; rebuilding against new head".into(),
            )),
            other => Err(StepError::Retry(format!("updating ref returned {other}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{self, AppState};
    use crate::config::Args;
    use axum::{
        extract::{Path, State as AxumState},
        http::StatusCode,
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use opensesame_connection_broker::github_app::GithubAppCredentials;
    use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
    use opensesame_storage::StoredSyncBlob;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MockGithub {
        head: Option<String>,
        trees: Vec<serde_json::Value>,
        commits: u32,
        mint_status: u16,
        ref_update_failures: u32,
    }

    type Shared = Arc<Mutex<MockGithub>>;

    async fn start_mock(mock: Shared) -> String {
        let app = Router::new()
            .route(
                "/app/installations/{id}/access_tokens",
                post(|AxumState(mock): AxumState<Shared>| async move {
                    let status = mock.lock().unwrap().mint_status;
                    if status == 201 {
                        (
                            StatusCode::CREATED,
                            Json(serde_json::json!({
                                "token": "installation-token",
                                "expires_at": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                            })),
                        )
                            .into_response()
                    } else {
                        StatusCode::from_u16(status).unwrap().into_response()
                    }
                }),
            )
            .route(
                "/repos/{owner}/{repo}/git/ref/heads/{branch}",
                get(|AxumState(mock): AxumState<Shared>| async move {
                    match mock.lock().unwrap().head.clone() {
                        Some(sha) => (
                            StatusCode::OK,
                            Json(serde_json::json!({"object": {"sha": sha}})),
                        )
                            .into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }),
            )
            .route(
                "/repos/{owner}/{repo}",
                get(|| async { Json(serde_json::json!({"default_branch": "main"})) }),
            )
            .route(
                "/repos/{owner}/{repo}/git/trees",
                post(
                    |AxumState(mock): AxumState<Shared>, Json(body): Json<serde_json::Value>| async move {
                        let mut mock = mock.lock().unwrap();
                        mock.trees.push(body);
                        let sha = format!("tree-{}", mock.trees.len());
                        (StatusCode::CREATED, Json(serde_json::json!({"sha": sha})))
                    },
                ),
            )
            .route(
                "/repos/{owner}/{repo}/git/commits/{sha}",
                get(|Path((_, _, _sha)): Path<(String, String, String)>| async move {
                    // Parent tree never matches a fresh snapshot in these tests.
                    Json(serde_json::json!({"tree": {"sha": "different"}}))
                }),
            )
            .route(
                "/repos/{owner}/{repo}/git/commits",
                post(|AxumState(mock): AxumState<Shared>| async move {
                    let mut mock = mock.lock().unwrap();
                    mock.commits += 1;
                    let sha = format!("commit-{}", mock.commits);
                    (StatusCode::CREATED, Json(serde_json::json!({"sha": sha})))
                }),
            )
            .route(
                "/repos/{owner}/{repo}/git/refs",
                post(|AxumState(mock): AxumState<Shared>| async move {
                    let mut mock = mock.lock().unwrap();
                    if mock.ref_update_failures > 0 {
                        mock.ref_update_failures -= 1;
                        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
                    }
                    let sha = format!("commit-{}", mock.commits);
                    mock.head = Some(sha.clone());
                    (StatusCode::CREATED, Json(serde_json::json!({"object": {"sha": sha}})))
                        .into_response()
                }),
            )
            .with_state(mock);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        base
    }

    fn throwaway_rsa_pem() -> Option<String> {
        let output = std::process::Command::new("openssl")
            .args(["genrsa", "2048"])
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).ok())?
    }

    async fn state_with_broker() -> AppState {
        let mut state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let config = BrokerConfig::in_memory(Some([11u8; 32]), "http://127.0.0.1:8787");
        state.connection_broker =
            Arc::new(ConnectionBroker::new(state.db.pool().clone(), config).unwrap());
        state
    }

    async fn insert_org(state: &AppState) -> String {
        let organization = state.connection_organization.to_string();
        sqlx::query(
            "INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)",
        )
        .bind(&organization)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(state.db.pool())
        .await
        .unwrap();
        organization
    }

    /// Registered app + configured target, the way Pages sets them up.
    async fn configure_target(state: &AppState, pem: String) -> String {
        let organization = insert_org(state).await;
        let integration = state
            .connection_broker
            .register_github_app_credentials(
                &state.connection_organization,
                &GithubAppCredentials {
                    id: 4242,
                    name: "Backup App".into(),
                    client_id: "Iv1.test".into(),
                    client_secret: "secret".into(),
                    html_url: None,
                    pem: Some(pem),
                    webhook_secret: Some("hook".into()),
                },
                "test",
            )
            .await
            .unwrap();
        state
            .db
            .upsert_backup_target(&BackupTarget {
                organization_id: organization.clone(),
                integration_id: integration.id.clone(),
                installation_id: "777".into(),
                owner: "acme".into(),
                repo: "opensesame-passwords".into(),
                branch: "main".into(),
                enabled: true,
                status: "pending".into(),
                last_commit_sha: None,
                last_synced_at: None,
                last_error: None,
            })
            .await
            .unwrap();
        organization
    }

    #[tokio::test]
    async fn a_secret_change_becomes_a_ciphertext_snapshot_commit() {
        let Some(pem) = throwaway_rsa_pem() else {
            eprintln!("skipping: openssl unavailable");
            return;
        };
        let state = state_with_broker().await;
        let organization = configure_target(&state, pem).await;
        let mock = Shared::default();
        mock.lock().unwrap().mint_status = 201;
        let base = start_mock(mock.clone()).await;

        // The mutation broadcasts its change event transactionally.
        state
            .db
            .write_sync_blob(
                "owner-1",
                &StoredSyncBlob {
                    id: "blob-1".into(),
                    epoch: 1,
                    ciphertext: vec![9, 9, 9],
                },
                100,
                100,
            )
            .await
            .unwrap();
        assert!(state.db.count_unpublished_outbox().await.unwrap() > 0);

        let mut cache = None;
        pass(&state, &base, &mut cache).await.unwrap();

        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 0);
        let target = state
            .db
            .get_backup_target(&organization)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.status, "ok");
        assert_eq!(target.last_commit_sha.as_deref(), Some("commit-1"));

        // The pushed tree is a complete ciphertext snapshot.
        let trees = mock.lock().unwrap().trees.clone();
        let entries = trees[0]["tree"].as_array().unwrap();
        let paths: Vec<&str> = entries
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"README.md"));
        assert!(paths.contains(&"manifest.json"));
        assert!(paths.contains(&"sync/b3duZXItMQ/YmxvYi0x.json"));
        let blob_entry = entries
            .iter()
            .find(|entry| entry["path"] == "sync/b3duZXItMQ/YmxvYi0x.json")
            .unwrap();
        // Ciphertext travels base64-wrapped; the raw bytes never appear.
        assert!(blob_entry["content"]
            .as_str()
            .unwrap()
            .contains("ciphertext_b64"));
    }

    #[tokio::test]
    async fn an_uninstalled_app_suspends_the_target_and_parks_events() {
        let Some(pem) = throwaway_rsa_pem() else {
            eprintln!("skipping: openssl unavailable");
            return;
        };
        let state = state_with_broker().await;
        let organization = configure_target(&state, pem).await;
        let mock = Shared::default();
        mock.lock().unwrap().mint_status = 404;
        let base = start_mock(mock.clone()).await;

        state.db.append_outbox("backup.resync", "{}").await.unwrap();
        let mut cache = None;
        pass(&state, &base, &mut cache).await.unwrap();

        let target = state
            .db
            .get_backup_target(&organization)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.status, "suspended");
        assert!(target.last_error.is_some());
        // Parked, not lost: the event replays once a human reconfigures.
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn a_lost_ref_race_compensates_by_rebuilding_next_pass() {
        let Some(pem) = throwaway_rsa_pem() else {
            eprintln!("skipping: openssl unavailable");
            return;
        };
        let state = state_with_broker().await;
        let organization = configure_target(&state, pem).await;
        let mock = Shared::default();
        {
            let mut guard = mock.lock().unwrap();
            guard.mint_status = 201;
            guard.ref_update_failures = 1;
        }
        let base = start_mock(mock.clone()).await;

        state.db.append_outbox("backup.resync", "{}").await.unwrap();
        let mut cache = None;
        pass(&state, &base, &mut cache).await.unwrap();

        // First pass lost the race: events parked with an attempt recorded.
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);

        // Release the backoff and run the compensating pass.
        sqlx::query("UPDATE outbox_events SET available_at = NULL WHERE published_at IS NULL")
            .execute(state.db.pool())
            .await
            .unwrap();
        pass(&state, &base, &mut cache).await.unwrap();

        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 0);
        let target = state
            .db
            .get_backup_target(&organization)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.status, "ok");
        assert_eq!(target.last_commit_sha.as_deref(), Some("commit-2"));
    }

    #[tokio::test]
    async fn events_without_a_target_are_drained_not_queued_forever() {
        let state = state_with_broker().await;
        state.db.append_outbox("backup.resync", "{}").await.unwrap();
        let mut cache = None;
        pass(&state, "http://127.0.0.1:1", &mut cache)
            .await
            .unwrap();
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 0);
    }
}
