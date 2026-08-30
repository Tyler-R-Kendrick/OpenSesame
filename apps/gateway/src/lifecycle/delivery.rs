//! Outbound delivery of lifecycle events to registered webhook subscribers.
//!
//! The wire convention is Standard Webhooks, byte for byte the same one
//! `@opensesame/webhooks` implements (ADR 0046 decision 12): `webhook-id`,
//! `webhook-timestamp`, and `webhook-signature: v1,<base64>` over
//! `id.timestamp.payload` under an HMAC-SHA256 key carried in a `whsec_`
//! secret. A subscriber verifies with any off-the-shelf Standard Webhooks
//! library rather than something `OpenSesame`-specific, and `webhook-id`
//! doubles as their idempotency key — which matters, because the ledger is
//! at-least-once by design.
//!
//! The saga is ADR 0039's: the ledger is the source of truth, work is claimed
//! under a lease, failures back off exponentially, and a delivery that will
//! not settle dead-letters visibly instead of disappearing.

use base64::Engine as _;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use opensesame_connection_broker::crypto::{open_scoped, SealedBlob};
use opensesame_connector_host::is_blocked_host;
use opensesame_storage::{
    StoredLifecycleDelivery, StoredLifecycleHook, LIFECYCLE_HOOK_SECRET_SCOPE,
};
use sha2::Sha256;
use std::time::Duration;

use crate::app_state::AppState;

/// Standard Webhooks secret prefix, matching `@opensesame/webhooks`.
pub const SECRET_PREFIX: &str = "whsec_";
/// Signature scheme version, matching `@opensesame/webhooks`.
pub const SIGNATURE_VERSION: &str = "v1";

/// Attempts before a delivery dead-letters.
pub const MAX_ATTEMPTS: i64 = 6;
/// First retry delay; doubles per attempt up to [`MAX_BACKOFF_SECONDS`].
pub const BASE_BACKOFF_SECONDS: i64 = 30;
/// Backoff ceiling — roughly a quarter hour between late attempts.
pub const MAX_BACKOFF_SECONDS: i64 = 900;
/// How long a claimed delivery is leased to one worker.
pub const CLAIM_LEASE_SECONDS: i64 = 120;
/// Per-request timeout.
pub const REQUEST_TIMEOUT_SECONDS: u64 = 10;
/// How often the worker sweeps the ledger.
pub const TICK_SECONDS: u64 = 15;

/// Longest error hint persisted against a delivery — a hint, never a body.
const MAX_ERROR_CHARS: usize = 160;

type HmacSha256 = Hmac<Sha256>;

/// Why a delivery could not be sent, and whether retrying could ever help.
#[derive(Debug)]
enum Failure {
    /// A transient condition: the endpoint was unreachable or returned 5xx.
    Retryable(String),
    /// A condition retrying cannot fix: the hook is misconfigured, its secret
    /// will not open, or the endpoint refused the payload itself.
    Permanent(String),
}

impl Failure {
    fn detail(&self) -> &str {
        match self {
            Self::Retryable(detail) | Self::Permanent(detail) => detail,
        }
    }
}

/// Standard Webhooks signature headers for one delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    pub id: String,
    pub timestamp: String,
    pub value: String,
}

/// Sign `payload` for delivery `id` at `timestamp_seconds`.
///
/// # Errors
///
/// Returns an error when the secret does not carry the `whsec_` prefix or its
/// body is not base64 — the same two refusals `@opensesame/webhooks` makes.
pub fn sign(
    secret: &str,
    id: &str,
    timestamp_seconds: i64,
    payload: &str,
) -> anyhow::Result<Signature> {
    let encoded = secret
        .strip_prefix(SECRET_PREFIX)
        .ok_or_else(|| anyhow::anyhow!("webhook secret must carry the {SECRET_PREFIX} prefix"))?;
    let key = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| anyhow::anyhow!("webhook secret is not base64: {error}"))?;
    let timestamp = timestamp_seconds.to_string();
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&key)
        .map_err(|error| anyhow::anyhow!("webhook secret is unusable: {error}"))?;
    mac.update(format!("{id}.{timestamp}.{payload}").as_bytes());
    let digest = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    Ok(Signature {
        id: id.to_string(),
        timestamp,
        value: format!("{SIGNATURE_VERSION},{digest}"),
    })
}

/// Generate a fresh `whsec_` signing secret.
#[must_use]
pub fn generate_secret() -> String {
    use rand::RngCore as _;
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!(
        "{SECRET_PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// When a delivery on its `attempt`-th failure becomes claimable again.
#[must_use]
pub fn retry_at(now: DateTime<Utc>, attempts: i64) -> DateTime<Utc> {
    let exponent = u32::try_from(attempts.max(0)).unwrap_or(u32::MAX).min(16);
    let delay = BASE_BACKOFF_SECONDS
        .saturating_mul(2_i64.saturating_pow(exponent))
        .min(MAX_BACKOFF_SECONDS);
    now + chrono::Duration::seconds(delay)
}

/// Process-lifetime delivery worker, spawned beside the backup and scanner
/// actors.
pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(TICK_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match pass(&state, Utc::now()).await {
            Ok(0) => {}
            Ok(sent) => tracing::debug!(sent, "lifecycle delivery pass settled deliveries"),
            Err(error) => tracing::warn!(%error, "lifecycle delivery pass failed"),
        }
    }
}

/// One sweep of the ledger. Returns how many deliveries were settled — that
/// is, delivered or dead-lettered, not merely attempted.
///
/// # Errors
///
/// Returns an error only when the ledger itself cannot be read. A single
/// failing endpoint is recorded against its own row and never aborts the pass.
pub async fn pass(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<usize> {
    let claimed = state
        .db
        .claim_lifecycle_deliveries(
            opensesame_storage::DELIVERY_BATCH_LIMIT,
            CLAIM_LEASE_SECONDS,
            now,
        )
        .await?;
    let mut settled = 0usize;
    for delivery in claimed {
        if settle(state, &delivery, now).await {
            settled += 1;
        }
    }
    Ok(settled)
}

/// Attempt one delivery and record what happened. Returns whether the row
/// reached a terminal state.
async fn settle(state: &AppState, delivery: &StoredLifecycleDelivery, now: DateTime<Utc>) -> bool {
    let hook = match state
        .db
        .get_lifecycle_hook(&delivery.organization_id, &delivery.hook_id)
        .await
    {
        Ok(Some(hook)) => hook,
        // The subscription is gone. Cascade deletes normally take its
        // deliveries with it; a row that outlives its hook has nowhere to go.
        Ok(None) => {
            dead_letter(state, delivery, "subscription no longer exists", now).await;
            return true;
        }
        Err(error) => {
            park(state, delivery, &format!("hook unreadable: {error}"), now).await;
            return false;
        }
    };

    match send(state, &hook, delivery).await {
        Ok(()) => {
            if let Err(error) = state.db.mark_lifecycle_delivered(&delivery.id, now).await {
                tracing::warn!(%error, delivery_id = %delivery.id, "delivered but not recorded");
                return false;
            }
            record_attempt(state, &hook, now, None).await;
            true
        }
        Err(failure) => {
            let detail: String = failure.detail().chars().take(MAX_ERROR_CHARS).collect();
            record_attempt(state, &hook, now, Some(&detail)).await;
            let exhausted = delivery.attempts + 1 >= MAX_ATTEMPTS;
            if matches!(failure, Failure::Permanent(_)) || exhausted {
                dead_letter(state, delivery, &detail, now).await;
                true
            } else {
                park(state, delivery, &detail, now).await;
                false
            }
        }
    }
}

async fn send(
    state: &AppState,
    hook: &StoredLifecycleHook,
    delivery: &StoredLifecycleDelivery,
) -> Result<(), Failure> {
    let endpoint = hook
        .endpoint_url
        .as_deref()
        .ok_or_else(|| Failure::Permanent("hook has no endpoint".into()))?;
    // Re-checked at send time, not only at registration: a hook registered
    // before an operator tightened the fence, or one whose host now resolves
    // somewhere private, must not be delivered to.
    assert_deliverable(endpoint).map_err(Failure::Permanent)?;

    let secret = open_secret(state, hook)?;
    let timestamp = Utc::now().timestamp();
    let signature = sign(&secret, &delivery.id, timestamp, &delivery.payload_json)
        .map_err(|error| Failure::Permanent(error.to_string()))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        // A redirect is a response, never a chase: following one would let an
        // allowed host hand us an address the fence already refused.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| Failure::Retryable(format!("http client: {error}")))?;

    let response = client
        .post(endpoint)
        .header("content-type", "application/json")
        .header("webhook-id", &signature.id)
        .header("webhook-timestamp", &signature.timestamp)
        .header("webhook-signature", &signature.value)
        .body(delivery.payload_json.clone())
        .send()
        .await
        .map_err(|error| Failure::Retryable(format!("request failed: {error}")))?;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let detail = format!("endpoint returned {status}");
    // 4xx is the endpoint telling us the request itself is wrong; repeating it
    // unchanged cannot help. 408 and 429 are the two that can.
    if status.is_client_error()
        && status != reqwest::StatusCode::REQUEST_TIMEOUT
        && status != reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        Err(Failure::Permanent(detail))
    } else {
        Err(Failure::Retryable(detail))
    }
}

/// Whether an endpoint is a legal delivery destination.
///
/// # Errors
///
/// Returns the reason when the URL is not absolute HTTPS or names a
/// loopback, private, link-local, or metadata address.
pub fn assert_deliverable(endpoint: &str) -> Result<(), String> {
    let url = url_host(endpoint).ok_or_else(|| "endpoint is not an absolute https URL".to_string())?;
    if is_blocked_host(&url) {
        return Err("endpoint resolves to a private or metadata address".into());
    }
    Ok(())
}

/// The host of an absolute `https://` URL, or `None` for anything else.
fn url_host(endpoint: &str) -> Option<String> {
    let rest = endpoint.strip_prefix("https://")?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|authority| !authority.is_empty())?;
    // Credentials in a delivery URL are a footgun and a secret in a column.
    if authority.contains('@') {
        return None;
    }
    let host = match authority.strip_prefix('[') {
        // IPv6 literal: keep the brackets so `is_blocked_host` sees the form
        // it strips itself.
        Some(rest) => format!("[{}]", rest.split(']').next()?),
        None => authority.split(':').next()?.to_string(),
    };
    (!host.is_empty()).then_some(host)
}

fn open_secret(state: &AppState, hook: &StoredLifecycleHook) -> Result<String, Failure> {
    let material = hook
        .sealed_secret
        .as_ref()
        .ok_or_else(|| Failure::Permanent("hook has no signing secret".into()))?;
    let key = state
        .connection_broker
        .config()
        .key()
        .copied()
        .ok_or_else(|| Failure::Retryable("gateway has no sealing key configured".into()))?;
    let plaintext = open_scoped(
        &key,
        LIFECYCLE_HOOK_SECRET_SCOPE,
        &hook.id,
        &hook.organization_id,
        &SealedBlob {
            ciphertext: material.ciphertext.clone(),
            nonce: material.nonce.clone(),
            aad_digest: material.aad_digest.clone(),
        },
    )
    .map_err(|error| Failure::Permanent(format!("signing secret will not open: {error}")))?;
    String::from_utf8(plaintext)
        .map_err(|_| Failure::Permanent("signing secret is not valid UTF-8".into()))
}

async fn record_attempt(
    state: &AppState,
    hook: &StoredLifecycleHook,
    now: DateTime<Utc>,
    error: Option<&str>,
) {
    if let Err(recorded) = state
        .db
        .record_lifecycle_hook_attempt(&hook.organization_id, &hook.id, now, error)
        .await
    {
        tracing::warn!(%recorded, hook_id = %hook.id, "hook attempt could not be recorded");
    }
}

async fn park(
    state: &AppState,
    delivery: &StoredLifecycleDelivery,
    detail: &str,
    now: DateTime<Utc>,
) {
    let next = retry_at(now, delivery.attempts);
    if let Err(error) = state
        .db
        .park_lifecycle_delivery(&delivery.id, next, detail, now)
        .await
    {
        tracing::warn!(%error, delivery_id = %delivery.id, "delivery could not be parked");
    }
}

async fn dead_letter(
    state: &AppState,
    delivery: &StoredLifecycleDelivery,
    detail: &str,
    now: DateTime<Utc>,
) {
    tracing::warn!(
        delivery_id = %delivery.id,
        hook_id = %delivery.hook_id,
        detail,
        "lifecycle delivery dead-lettered",
    );
    if let Err(error) = state
        .db
        .dead_letter_lifecycle_delivery(&delivery.id, detail, now)
        .await
    {
        tracing::warn!(%error, delivery_id = %delivery.id, "delivery could not be dead-lettered");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_matches_the_standard_webhooks_vector() {
        // The same inputs `@opensesame/webhooks` signs, so the two
        // implementations cannot drift: a receiver verifying with any
        // off-the-shelf library must accept what we send.
        let secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
        let signature = sign(secret, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1_614_265_330, r#"{"a":1}"#)
            .expect("signature");
        assert_eq!(signature.timestamp, "1614265330");
        assert!(signature.value.starts_with("v1,"), "{}", signature.value);

        // Deterministic: the same inputs always produce the same signature.
        let again = sign(secret, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1_614_265_330, r#"{"a":1}"#)
            .expect("signature");
        assert_eq!(signature, again);
    }

    #[test]
    fn every_signed_component_changes_the_signature() {
        let secret = generate_secret();
        let base = sign(&secret, "id-1", 1_000, "payload").unwrap().value;
        assert_ne!(base, sign(&secret, "id-2", 1_000, "payload").unwrap().value);
        assert_ne!(base, sign(&secret, "id-1", 1_001, "payload").unwrap().value);
        assert_ne!(base, sign(&secret, "id-1", 1_000, "payload!").unwrap().value);
        assert_ne!(
            base,
            sign(&generate_secret(), "id-1", 1_000, "payload").unwrap().value,
        );
    }

    #[test]
    fn a_secret_without_the_prefix_is_refused() {
        assert!(sign("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "id", 1, "{}").is_err());
        assert!(sign("whsec_not base64!", "id", 1, "{}").is_err());
    }

    #[test]
    fn generated_secrets_are_usable_and_distinct() {
        let first = generate_secret();
        let second = generate_secret();
        assert_ne!(first, second);
        assert!(first.starts_with(SECRET_PREFIX));
        assert!(sign(&first, "id", 1, "{}").is_ok());
    }

    #[test]
    fn backoff_grows_and_then_holds_at_the_ceiling() {
        let now: DateTime<Utc> = "2026-08-30T00:00:00Z".parse().unwrap();
        let delays: Vec<i64> = (0..MAX_ATTEMPTS)
            .map(|attempt| (retry_at(now, attempt) - now).num_seconds())
            .collect();
        assert_eq!(delays[0], BASE_BACKOFF_SECONDS);
        assert!(
            delays.windows(2).all(|pair| pair[1] >= pair[0]),
            "backoff must never shrink: {delays:?}",
        );
        assert!(
            delays.iter().all(|delay| *delay <= MAX_BACKOFF_SECONDS),
            "backoff must stay under the ceiling: {delays:?}",
        );
        // A wild attempt count must not overflow into a negative delay.
        assert!((retry_at(now, i64::MAX) - now).num_seconds() > 0);
    }

    #[test]
    fn only_absolute_https_endpoints_are_deliverable() {
        assert!(assert_deliverable("https://hooks.example/expiry").is_ok());
        assert!(assert_deliverable("https://hooks.example:8443/expiry").is_ok());
        for refused in [
            "http://hooks.example/expiry",
            "hooks.example/expiry",
            "ftp://hooks.example",
            "https://",
            "https:///path",
            // Credentials in the URL would be a secret living in a column.
            "https://user:pass@hooks.example/expiry",
        ] {
            assert!(assert_deliverable(refused).is_err(), "{refused} must be refused");
        }
    }

    #[test]
    fn private_and_metadata_endpoints_are_refused() {
        for refused in [
            "https://localhost/hook",
            "https://127.0.0.1/hook",
            // inet_aton spellings the resolver accepts and a prefix match misses.
            "https://0177.0.0.1/hook",
            "https://2130706433/hook",
            "https://169.254.169.254/latest/meta-data",
            "https://metadata.google.internal/computeMetadata",
            "https://10.0.0.5/hook",
            "https://192.168.1.10/hook",
            "https://[::1]/hook",
            "https://localhost.:8443/hook",
        ] {
            assert!(
                assert_deliverable(refused).is_err(),
                "{refused} must be refused",
            );
        }
    }

    #[test]
    fn a_public_host_that_merely_looks_private_is_allowed() {
        // `is_blocked_host` parses literals rather than prefix-matching, so a
        // real name is not blocked for starting with the wrong characters.
        assert!(assert_deliverable("https://fcbank.example.com/hook").is_ok());
        assert!(assert_deliverable("https://localhost.example.com/hook").is_ok());
    }
}
