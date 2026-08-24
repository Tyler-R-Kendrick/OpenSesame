//! Sync-on-write actor (WP-5; clones the ADR 0039 actor shape of `backup.rs`).
//!
//! Config-value mutations append `sync.config.dirty` rows to the dedicated
//! `config_sync_outbox` in the same transaction as the sealed write. This
//! actor drains them: wake on `sync_notify` (or the tick), claim a leased
//! batch, collapse it to distinct `(organization, config)` pairs — events are
//! triggers, state is the source of truth — and run a full-snapshot
//! `sync_all_for_config` per pair. Success marks the whole group published;
//! failure parks it with exponential backoff and dead-letters a poison group
//! after `max_attempts`, which stays safe because every later pass re-syncs
//! complete current state.
//!
//! Value discipline: secret values are loaded and resolved inside the broker
//! only. Everything this module stores or logs — park reasons, dead-letter
//! reasons — is a truncated provider/broker hint, never a value or token.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use opensesame_connection_broker::store as broker_store;
use opensesame_domain::OrganizationId;

use crate::app_state::AppState;

/// Hard cap on stored failure reasons. Provider error bodies are already
/// snipped upstream, but the outbox must never become a byte-for-byte mirror
/// of upstream responses.
pub const MAX_REASON_CHARS: usize = 160;

/// Knobs for one actor instance. Tests inject a zero backoff; production uses
/// `Default`.
#[derive(Clone, Copy, Debug)]
pub struct SyncActorConfig {
    pub batch_limit: i64,
    pub lease_seconds: i64,
    /// First park delay; doubles per attempt up to `backoff_cap_seconds`.
    pub backoff_base_seconds: i64,
    pub backoff_cap_seconds: i64,
    /// Attempts (claims) before a failing group is dead-lettered.
    pub max_attempts: i64,
}

impl Default for SyncActorConfig {
    fn default() -> Self {
        Self {
            batch_limit: 16,
            lease_seconds: 60,
            backoff_base_seconds: 30,
            backoff_cap_seconds: 3600,
            max_attempts: 8,
        }
    }
}

fn tick_interval() -> Duration {
    std::env::var("OPENSESAME_SYNC_ACTOR_TICK_SECONDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .map_or(Duration::from_secs(30), Duration::from_secs)
}

/// Run the actor until the process exits. Spawned once from `main`; the
/// `sync_notify` handle on [`AppState`] wakes it immediately after a config
/// value is written, deleted, or rolled back, the tick covers everything else
/// (missed wakes, lease expiry, backoff release).
pub async fn run(state: AppState) {
    let cfg = SyncActorConfig::default();
    let interval = tick_interval();
    loop {
        tokio::select! {
            () = state.sync_notify.notified() => {}
            () = tokio::time::sleep(interval) => {}
        }
        if let Err(error) = pass(&state, &cfg).await {
            tracing::warn!(%error, "config sync pass failed");
        }
    }
}

/// One drain-and-sync pass. Public for tests.
pub async fn pass(state: &AppState, cfg: &SyncActorConfig) -> anyhow::Result<()> {
    let events =
        broker_store::claim_config_sync_batch(state.db.pool(), cfg.batch_limit, cfg.lease_seconds)
            .await?;
    if events.is_empty() {
        return Ok(());
    }

    // De-duplicate within the batch: a burst of writes to one config collapses
    // into a single full-snapshot sync, and its outcome settles every event in
    // the group at once.
    let mut groups: BTreeMap<(String, String), Vec<&broker_store::ConfigSyncEventRow>> =
        BTreeMap::new();
    for event in &events {
        groups
            .entry((event.organization_id.clone(), event.config_id.clone()))
            .or_default()
            .push(event);
    }

    for ((organization_id, config_id), group) in &groups {
        let ids: Vec<String> = group.iter().map(|event| event.id.clone()).collect();
        let attempts = group.iter().map(|event| event.attempts).max().unwrap_or(1);
        match sync_config(state, organization_id, config_id).await {
            Ok(()) => {
                broker_store::mark_config_sync_published(state.db.pool(), &ids).await?;
            }
            Err(reason) => {
                compensate_retry(state, cfg, &ids, attempts, &reason).await?;
            }
        }
    }
    Ok(())
}

/// Full-snapshot sync for one config. `Ok(())` means every target converged —
/// including the two no-op convergences: zero targets, and all targets already
/// carrying the current `cv2_` fingerprint (skip without egress). The error
/// string is value-blind and truncated, safe to persist as a park reason.
async fn sync_config(
    state: &AppState,
    organization_id: &str,
    config_id: &str,
) -> Result<(), String> {
    let organization = OrganizationId::parse(organization_id)
        .map_err(|_| "event carries a malformed organization id".to_string())?;
    let broker = &state.connection_broker;

    let targets = broker
        .list_sync_targets(&organization, None, Some(config_id))
        .await
        .map_err(|e| truncate_reason(&e.hint()))?;
    if targets.is_empty() {
        // Nothing to fan out to is a converged state, not a failure.
        return Ok(());
    }

    // Fail closed: a keyless deployment cannot sync (and cannot skip either —
    // the fingerprint is keyed).
    let secrets = broker
        .sync_secret_source()
        .map_err(|e| truncate_reason(&e.hint()))?;

    // Skip egress entirely when every target already carries the current
    // fingerprint. cv2 is value-sensitive, so "unchanged" is trustworthy; any
    // doubt (fingerprint error, missing/stale content_version) falls through
    // to a real sync.
    let mut all_current = true;
    for target in &targets {
        let current = broker
            .current_content_version(&organization, &target.id, Arc::clone(&secrets))
            .await;
        match current {
            Ok(cv) if target.content_version.as_deref() == Some(cv.as_str()) => {}
            _ => {
                all_current = false;
                break;
            }
        }
    }
    if all_current {
        return Ok(());
    }

    let outcomes = broker
        .sync_all_for_config(&organization, config_id, secrets)
        .await
        .map_err(|e| truncate_reason(&e.hint()))?;
    let failures: Vec<String> = outcomes
        .iter()
        .filter(|outcome| !outcome.ok)
        .map(|outcome| {
            format!(
                "{}: {}",
                outcome.target.id,
                outcome.error.as_deref().unwrap_or("sync failed")
            )
        })
        .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(truncate_reason(&failures.join("; ")))
    }
}

/// Compensation: park with exponential backoff, dead-letter a poison group at
/// `max_attempts`. Dead-lettering is safe because any later successful pass
/// pushes a complete snapshot that reconciles whatever the dropped events
/// described.
async fn compensate_retry(
    state: &AppState,
    cfg: &SyncActorConfig,
    ids: &[String],
    attempts: i64,
    reason: &str,
) -> anyhow::Result<()> {
    if attempts >= cfg.max_attempts {
        tracing::warn!(
            reason,
            max_attempts = cfg.max_attempts,
            "config sync group dead-lettered"
        );
        broker_store::dead_letter_config_sync(state.db.pool(), ids, reason).await?;
        return Ok(());
    }
    let backoff = backoff_seconds(cfg, attempts);
    broker_store::park_config_sync(state.db.pool(), ids, reason, backoff).await?;
    Ok(())
}

/// `base * 2^(attempts-1)`, capped. Attempt numbering starts at 1 (the claim
/// pre-increments), so the first failure parks for exactly the base delay.
fn backoff_seconds(cfg: &SyncActorConfig, attempts: i64) -> i64 {
    let doublings = u32::try_from((attempts - 1).clamp(0, 20))
        .expect("a value clamped to 0..=20 always fits in u32");
    cfg.backoff_base_seconds
        .saturating_mul(1i64 << doublings)
        .min(cfg.backoff_cap_seconds)
}

/// Bound a failure reason before it is persisted. Upstream hints already avoid
/// secret values; the cap keeps even a misbehaving provider body from being
/// mirrored into the outbox.
fn truncate_reason(raw: &str) -> String {
    if raw.chars().count() <= MAX_REASON_CHARS {
        return raw.to_string();
    }
    let mut out: String = raw.chars().take(MAX_REASON_CHARS - 1).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{test_demo_state, AppState};
    use opensesame_connection_broker::{
        BrokerConfig, ConnectionBroker, CreateConnection, CreateSecretConfig, CreateSyncTarget,
        SyncTargetStatus,
    };
    use sqlx::Row;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    const PLAINTEXT: &str = "sw0rdf1sh-actor-secret";
    const TOKEN: &str = "vercel_live_actor_token";

    fn test_cfg() -> SyncActorConfig {
        SyncActorConfig {
            backoff_base_seconds: 0,
            ..SyncActorConfig::default()
        }
    }

    async fn state_with_seal_key() -> AppState {
        let mut st = test_demo_state().await;
        st.connection_broker = Arc::new(
            ConnectionBroker::new(
                st.db.pool().clone(),
                BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
            )
            .unwrap(),
        );
        st
    }

    #[derive(Debug, Clone)]
    struct OutboxRow {
        attempts: i64,
        published: bool,
        dead_lettered: bool,
        last_error: Option<String>,
    }

    async fn outbox_rows(st: &AppState) -> Vec<OutboxRow> {
        sqlx::query(
            "SELECT attempts, published_at, dead_lettered_at, last_error \
             FROM config_sync_outbox ORDER BY created_at, id",
        )
        .fetch_all(st.db.pool())
        .await
        .unwrap()
        .into_iter()
        .map(|r| OutboxRow {
            attempts: r.get("attempts"),
            published: r.get::<Option<String>, _>("published_at").is_some(),
            dead_lettered: r.get::<Option<String>, _>("dead_lettered_at").is_some(),
            last_error: r.get("last_error"),
        })
        .collect()
    }

    /// Clear park delays so the next pass can claim immediately (tests run
    /// with a zero backoff base, but claim leases also set `available_at`).
    async fn release_backoff(st: &AppState) {
        sqlx::query(
            "UPDATE config_sync_outbox SET available_at = NULL \
             WHERE published_at IS NULL AND dead_lettered_at IS NULL",
        )
        .execute(st.db.pool())
        .await
        .unwrap();
    }

    /// Config with one sealed value; the write appends the outbox event.
    async fn seeded_config(st: &AppState, project: &str, slug: &str) -> String {
        let org = st.connection_organization.to_string();
        let config = st
            .connection_broker
            .create_secret_config(
                &org,
                CreateSecretConfig {
                    project_id: project.into(),
                    slug: slug.into(),
                    display_name: None,
                    environment: "development".into(),
                    parent_config_id: None,
                },
                Some("test"),
            )
            .await
            .unwrap();
        let mut secrets = BTreeMap::new();
        secrets.insert("API_KEY".to_string(), PLAINTEXT.to_string());
        st.connection_broker
            .put_config_secrets(&org, &config.id, &secrets, Some("test"))
            .await
            .unwrap();
        config.id
    }

    async fn vercel_target(
        st: &AppState,
        project: &str,
        config_id: &str,
        with_credential: bool,
    ) -> String {
        let org = st.connection_organization;
        let connection = st
            .connection_broker
            .create_connection(
                &org,
                CreateConnection {
                    provider_id: "vercel".into(),
                    integration_id: None,
                    owner_subject: Some("principal:actor-test".into()),
                    display_name: Some("Vercel".into()),
                    logical_name: None,
                    project_id: Some(project.into()),
                    scopes: None,
                    shareability: None,
                },
            )
            .await
            .unwrap();
        if with_credential {
            st.connection_broker
                .set_api_key(&org, &connection.connection_id, TOKEN)
                .await
                .unwrap();
        }
        st.connection_broker
            .create_sync_target(
                &org,
                CreateSyncTarget {
                    project_id: project.into(),
                    config_id: config_id.into(),
                    connection_id: connection.connection_id.clone(),
                    operation: Some("env.set".into()),
                },
            )
            .await
            .unwrap()
            .id
    }

    /// (a) End-to-end against unreachable egress: the pass parks the event
    /// with attempts grown, records target status Error, and neither the
    /// stored value nor the connection token leaks into any persisted detail.
    #[tokio::test]
    async fn unreachable_egress_parks_events_and_stays_value_blind() {
        let st = state_with_seal_key().await;
        let config_id = seeded_config(&st, "proj-a", "development").await;
        let target_id = vercel_target(&st, "proj-a", &config_id, true).await;

        let before = outbox_rows(&st).await;
        assert_eq!(before.len(), 1);
        assert!(!before[0].published);
        assert_eq!(before[0].attempts, 0);

        pass(&st, &test_cfg()).await.unwrap();

        let rows = outbox_rows(&st).await;
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].published);
        assert!(!rows[0].dead_lettered);
        assert_eq!(rows[0].attempts, 1);
        let reason = rows[0].last_error.clone().expect("park reason recorded");
        assert!(reason.chars().count() <= MAX_REASON_CHARS);
        assert!(!reason.contains(PLAINTEXT));
        assert!(!reason.contains(TOKEN));

        let target = st
            .connection_broker
            .get_sync_target(&st.connection_organization, &target_id)
            .await
            .unwrap();
        assert_eq!(target.status, SyncTargetStatus::Error);
        let detail = target.status_detail.unwrap_or_default();
        assert!(!detail.contains(PLAINTEXT));
        assert!(!detail.contains(TOKEN));
    }

    /// (b) Zero sync targets for a config is success, not a retry loop.
    #[tokio::test]
    async fn a_config_with_no_targets_publishes_immediately() {
        let st = state_with_seal_key().await;
        let config_id = seeded_config(&st, "proj-b", "development").await;
        // A second write to the same config: the batch de-duplicates to one
        // group and one outcome settles both events.
        let mut more = BTreeMap::new();
        more.insert("SECOND_KEY".to_string(), "second-value".to_string());
        st.connection_broker
            .put_config_secrets(
                &st.connection_organization.to_string(),
                &config_id,
                &more,
                Some("test"),
            )
            .await
            .unwrap();

        pass(&st, &test_cfg()).await.unwrap();

        let rows = outbox_rows(&st).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.published && !r.dead_lettered));
    }

    /// (c) A group that keeps failing dead-letters after `max_attempts`, and a
    /// dead-lettered event is never claimed again. The connection carries no
    /// credential, so every attempt fails fast and without egress.
    #[tokio::test]
    async fn a_poison_config_dead_letters_after_max_attempts() {
        let st = state_with_seal_key().await;
        let config_id = seeded_config(&st, "proj-c", "development").await;
        vercel_target(&st, "proj-c", &config_id, false).await;
        let cfg = test_cfg();

        for attempt in 1..cfg.max_attempts {
            release_backoff(&st).await;
            pass(&st, &cfg).await.unwrap();
            let rows = outbox_rows(&st).await;
            assert!(
                !rows[0].dead_lettered,
                "attempt {attempt} must park, not dead-letter"
            );
            assert!(!rows[0].published);
            assert_eq!(rows[0].attempts, attempt);
        }

        release_backoff(&st).await;
        pass(&st, &cfg).await.unwrap();
        let rows = outbox_rows(&st).await;
        assert!(rows[0].dead_lettered);
        assert!(!rows[0].published);
        assert_eq!(rows[0].attempts, cfg.max_attempts);
        let reason = rows[0].last_error.clone().unwrap();
        assert!(!reason.contains(PLAINTEXT));

        // Terminal: another pass claims nothing and grows nothing.
        pass(&st, &cfg).await.unwrap();
        assert_eq!(outbox_rows(&st).await[0].attempts, cfg.max_attempts);
    }

    /// (d) Skip: when every target already carries the current `cv2_`
    /// fingerprint the pass publishes without egress. Egress in this test
    /// environment always fails, so "published AND the target still Ready"
    /// proves no egress was attempted; a value change then re-arms the sync.
    #[tokio::test]
    async fn unchanged_fingerprints_publish_without_egress() {
        let st = state_with_seal_key().await;
        let org = st.connection_organization;
        let config_id = seeded_config(&st, "proj-d", "development").await;
        let target_id = vercel_target(&st, "proj-d", &config_id, true).await;

        // Simulate an earlier converged sync: stamp the target with the
        // current fingerprint via the broker helper the actor itself uses.
        let secrets = st.connection_broker.sync_secret_source().unwrap();
        let cv = st
            .connection_broker
            .current_content_version(&org, &target_id, secrets)
            .await
            .unwrap();
        assert!(cv.starts_with("cv2_"));
        broker_store::update_sync_target_status(
            st.db.pool(),
            &target_id,
            "ready",
            None,
            Some(&cv),
            Some(&chrono::Utc::now().to_rfc3339()),
        )
        .await
        .unwrap();

        pass(&st, &test_cfg()).await.unwrap();

        let rows = outbox_rows(&st).await;
        assert!(rows.iter().all(|r| r.published));
        let target = st
            .connection_broker
            .get_sync_target(&org, &target_id)
            .await
            .unwrap();
        assert_eq!(target.status, SyncTargetStatus::Ready);
        assert_eq!(target.content_version.as_deref(), Some(cv.as_str()));

        // A value change moves the fingerprint: the next pass must attempt a
        // real sync again (which parks here, egress being unreachable).
        let mut rotated = BTreeMap::new();
        rotated.insert("API_KEY".to_string(), "rotated-value".to_string());
        st.connection_broker
            .put_config_secrets(&org.to_string(), &config_id, &rotated, Some("test"))
            .await
            .unwrap();
        pass(&st, &test_cfg()).await.unwrap();
        let rows = outbox_rows(&st).await;
        assert!(rows.iter().any(|r| !r.published && !r.dead_lettered));
    }

    /// (e) Idempotency: re-running after publish claims nothing and changes
    /// nothing.
    #[tokio::test]
    async fn republished_events_are_not_reprocessed() {
        let st = state_with_seal_key().await;
        seeded_config(&st, "proj-e", "development").await;
        let cfg = test_cfg();

        pass(&st, &cfg).await.unwrap();
        let after_first = outbox_rows(&st).await;
        assert!(after_first.iter().all(|r| r.published));

        pass(&st, &cfg).await.unwrap();
        let after_second = outbox_rows(&st).await;
        assert_eq!(after_first.len(), after_second.len());
        for (a, b) in after_first.iter().zip(&after_second) {
            assert_eq!(a.attempts, b.attempts);
            assert!(b.published);
        }
    }

    #[test]
    fn backoff_doubles_from_base_and_caps_at_one_hour() {
        let cfg = SyncActorConfig::default();
        assert_eq!(backoff_seconds(&cfg, 1), 30);
        assert_eq!(backoff_seconds(&cfg, 2), 60);
        assert_eq!(backoff_seconds(&cfg, 3), 120);
        assert_eq!(backoff_seconds(&cfg, 7), 1920);
        assert_eq!(backoff_seconds(&cfg, 8), 3600);
        assert_eq!(backoff_seconds(&cfg, 60), 3600);
        let zero = SyncActorConfig {
            backoff_base_seconds: 0,
            ..cfg
        };
        assert_eq!(backoff_seconds(&zero, 5), 0);
    }

    #[test]
    fn reasons_are_truncated_before_persistence() {
        let short = truncate_reason("upstream 502");
        assert_eq!(short, "upstream 502");
        let long = truncate_reason(&"x".repeat(4096));
        assert_eq!(long.chars().count(), MAX_REASON_CHARS);
        assert!(long.ends_with('…'));
    }
}
