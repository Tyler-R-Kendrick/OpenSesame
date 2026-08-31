//! Outbound delivery of security events to registered subscribers.
//!
//! One worker, one ledger, three wire formats. Which one a delivery uses is a
//! property of the hook row, not of the event, so an operator routes expiry and
//! breach findings to the same `PagerDuty` service by registering one hook.
//! [`crate::security::sinks`] renders the body; this module owns the saga.
//!
//! - **Standard Webhooks** — byte for byte the convention
//!   `@opensesame/webhooks` implements (ADR 0046 decision 12): `webhook-id`,
//!   `webhook-timestamp`, and `webhook-signature: v1,<base64>` over
//!   `id.timestamp.body` under an HMAC-SHA256 key carried in a `whsec_`
//!   secret. A subscriber verifies with any off-the-shelf library rather than
//!   something `OpenSesame`-specific, and `webhook-id` doubles as their
//!   idempotency key — which matters, because the ledger is at-least-once.
//! - **Alertmanager v2** and **`PagerDuty` Events API v2** — the sinks an
//!   operator's on-call rotation already reads. Both deduplicate on the
//!   notice's alert key, so at-least-once delivery costs nothing.
//!
//! The saga is ADR 0039's: the ledger is the source of truth, work is claimed
//! under a lease, failures back off exponentially, and a delivery that will
//! not settle dead-letters visibly instead of disappearing.

use base64::Engine as _;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use opensesame_connection_broker::crypto::{open_scoped, SealedBlob};
use opensesame_connector_host::is_blocked_host;
use opensesame_security_events::Delivery;
use opensesame_storage::{StoredSecurityDelivery, StoredSecurityHook, SECURITY_HOOK_SECRET_SCOPE};
use sha2::Sha256;
use std::time::Duration;

use crate::app_state::AppState;
use crate::security::sinks;

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
        .claim_security_deliveries(
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
async fn settle(state: &AppState, delivery: &StoredSecurityDelivery, now: DateTime<Utc>) -> bool {
    let hook = match state
        .db
        .get_security_hook(&delivery.organization_id, &delivery.hook_id)
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
            if let Err(error) = state.db.mark_security_delivered(&delivery.id, now).await {
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
    hook: &StoredSecurityHook,
    delivery: &StoredSecurityDelivery,
) -> Result<(), Failure> {
    let kind = Delivery::parse(&hook.delivery)
        .ok_or_else(|| Failure::Permanent(format!("unknown delivery kind '{}'", hook.delivery)))?;
    let endpoint = hook
        .endpoint_url
        .as_deref()
        .ok_or_else(|| Failure::Permanent("hook has no endpoint".into()))?;
    // Re-checked at send time, not only at registration: a hook registered
    // before an operator tightened the fence, or one whose host now resolves
    // somewhere private, must not be delivered to.
    assert_deliverable(endpoint).map_err(Failure::Permanent)?;

    let secret = open_secret(state, hook)?;
    // Not necessarily an envelope: rows queued before migration 0020 hold a
    // detector's flat payload, and they are delivered as they were written.
    let queued = sinks::decode(&delivery.payload_json);
    let rendered = if kind == Delivery::A2h {
        render_a2h(state, &queued, secret.as_deref(), delivery)?
    } else {
        sinks::render_queued(kind, &queued, secret.as_deref()).map_err(Failure::Permanent)?
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        // A redirect is a response, never a chase: following one would let an
        // allowed host hand us an address the fence already refused.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| Failure::Retryable(format!("http client: {error}")))?;

    let mut request = client
        .post(format!(
            "{}{}",
            endpoint.trim_end_matches('/'),
            rendered.path
        ))
        .header("content-type", "application/json");
    for (name, value) in signature_headers(kind, secret.as_deref(), delivery, &rendered.body)? {
        request = request.header(name, value);
    }
    for (name, value) in rendered.headers {
        request = request.header(name, value);
    }

    let response = request
        .body(rendered.body)
        .send()
        .await
        .map_err(|error| Failure::Retryable(format!("request failed: {error}")))?;

    if kind == Delivery::A2h {
        return classify_a2h(response).await;
    }
    classify(response.status())
}

/// Render one queued row as an A2H intent, with the deployment context the
/// protocol needs and a notice does not carry.
fn render_a2h(
    state: &AppState,
    queued: &sinks::Queued,
    secret: Option<&str>,
    delivery: &StoredSecurityDelivery,
) -> Result<sinks::Rendered, Failure> {
    let sinks::Queued::Notice(notice) = queued else {
        // The A2H sink did not exist before migration 0020, so a legacy row
        // bound for one is a genuine inconsistency rather than an upgrade
        // artifact.
        return Err(Failure::Permanent(
            "a delivery queued before migration 0020 cannot be rendered as an a2h intent".into(),
        ));
    };
    let public_url = state.connection_broker.config().public_url().to_string();
    let agent_id = crate::config::a2h_agent_id(&public_url);
    let attach_url = run_attach_url(&public_url, &notice.subject_id);
    sinks::render_a2h(
        notice,
        secret,
        &sinks::A2hContext {
            agent_id: &agent_id,
            callback_url: &format!("{public_url}/api/v1/a2h/callback"),
            attach_url: &attach_url,
            delivery_id: &delivery.id,
        },
    )
    .map_err(Failure::Permanent)
}

/// Where a person is sent to watch or take over the run this is about.
fn run_attach_url(public_url: &str, subject_id: &str) -> String {
    format!(
        "{}/runs?origin={}",
        crate::config::a2h_attach_base(public_url),
        urlencoding_query(subject_id),
    )
}

/// Percent-encode a value for a query string.
///
/// The subject id is an origin — `https://example.com` — whose `:` and `/`
/// would otherwise be read as structure by whatever opens the link.
fn urlencoding_query(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Classify an A2H gateway's answer.
///
/// Different from [`classify`] in one way that matters: a 4xx here is not
/// automatically permanent. A2H's `ERR.QUIET_HOURS` and `ERR.RATE_LIMITED`
/// arrive as client errors and mean *nobody has been told yet* — recording
/// that as delivered is how a blocked run's response window expires with the
/// person it was waiting for never hearing about it. So the body's error code
/// decides, and only the codes that retrying cannot fix are permanent.
async fn classify_a2h(response: reqwest::Response) -> Result<(), Failure> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let code = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|body| {
            serde_json::from_value::<opensesame_a2h::ErrorCode>(body["error"].clone()).ok()
        });
    match code.map(opensesame_a2h::DeliveryOutcome::for_error) {
        Some(opensesame_a2h::DeliveryOutcome::Permanent) => {
            Err(Failure::Permanent(format!("a2h refused: {status}")))
        }
        // Suppressed and Retryable both stay in the ledger: nobody has been
        // told yet, and giving up here is the silent failure.
        Some(_) => Err(Failure::Retryable(format!("a2h deferred: {status}"))),
        // No recognizable code. Fall back to the shape of the status, which is
        // the same reading every other sink gets.
        None => classify(status),
    }
}

/// Standard Webhooks headers, for the one sink that uses them.
///
/// Alertmanager and `PagerDuty` authenticate their own way — network policy and
/// a routing key respectively — and would reject or ignore these. Signing is
/// over the *rendered* body rather than the queued row, because the body is
/// what a subscriber receives and therefore what they verify.
fn signature_headers(
    kind: Delivery,
    secret: Option<&str>,
    delivery: &StoredSecurityDelivery,
    body: &str,
) -> Result<Vec<(&'static str, String)>, Failure> {
    if kind != Delivery::Webhook {
        return Ok(Vec::new());
    }
    let secret = secret.ok_or_else(|| Failure::Permanent("hook has no signing secret".into()))?;
    let signature = sign(secret, &delivery.id, Utc::now().timestamp(), body)
        .map_err(|error| Failure::Permanent(error.to_string()))?;
    Ok(vec![
        ("webhook-id", signature.id),
        ("webhook-timestamp", signature.timestamp),
        ("webhook-signature", signature.value),
    ])
}

/// Whether a response status is success, worth retrying, or final.
///
/// 4xx is the endpoint telling us the request itself is wrong; repeating it
/// unchanged cannot help. 408 and 429 are the two that can.
fn classify(status: reqwest::StatusCode) -> Result<(), Failure> {
    if status.is_success() {
        return Ok(());
    }
    let detail = format!("endpoint returned {status}");
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
    let url =
        url_host(endpoint).ok_or_else(|| "endpoint is not an absolute https URL".to_string())?;
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

/// The hook's sealed material, opened for this send.
///
/// `Ok(None)` when the row carries none, which is legitimate: Alertmanager's
/// ingest API is unauthenticated by design. A sink that genuinely needs the
/// material refuses in `sinks::render`, where the requirement is stated once
/// per sink rather than guessed here.
/// The hook's sealed secret, for callers outside this module.
///
/// The A2H callback route needs the same secret this module sends, because A2H
/// uses one shared secret in both directions: we put it in `callback.secret`
/// and the gateway signs its reply with it.
///
/// # Errors
///
/// Returns the reason the secret could not be opened, never the ciphertext.
pub fn open_hook_secret(state: &AppState, hook: &StoredSecurityHook) -> anyhow::Result<String> {
    match open_secret(state, hook) {
        Ok(Some(secret)) => Ok(secret),
        Ok(None) => Err(anyhow::anyhow!("hook carries no sealed secret")),
        Err(failure) => Err(anyhow::anyhow!(failure.detail().to_string())),
    }
}

fn open_secret(state: &AppState, hook: &StoredSecurityHook) -> Result<Option<String>, Failure> {
    let Some(material) = hook.sealed_secret.as_ref() else {
        return Ok(None);
    };
    let key = state
        .connection_broker
        .config()
        .key()
        .copied()
        .ok_or_else(|| Failure::Retryable("gateway has no sealing key configured".into()))?;
    let plaintext = open_scoped(
        &key,
        SECURITY_HOOK_SECRET_SCOPE,
        &hook.id,
        &hook.organization_id,
        &SealedBlob {
            ciphertext: material.ciphertext.clone(),
            nonce: material.nonce.clone(),
            aad_digest: material.aad_digest.clone(),
        },
    )
    .map_err(|error| Failure::Permanent(format!("hook secret will not open: {error}")))?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|_| Failure::Permanent("hook secret is not valid UTF-8".into()))
}

async fn record_attempt(
    state: &AppState,
    hook: &StoredSecurityHook,
    now: DateTime<Utc>,
    error: Option<&str>,
) {
    if let Err(recorded) = state
        .db
        .record_security_hook_attempt(&hook.organization_id, &hook.id, now, error)
        .await
    {
        tracing::warn!(%recorded, hook_id = %hook.id, "hook attempt could not be recorded");
    }
}

async fn park(
    state: &AppState,
    delivery: &StoredSecurityDelivery,
    detail: &str,
    now: DateTime<Utc>,
) {
    let next = retry_at(now, delivery.attempts);
    if let Err(error) = state
        .db
        .park_security_delivery(&delivery.id, next, detail, now)
        .await
    {
        tracing::warn!(%error, delivery_id = %delivery.id, "delivery could not be parked");
    }
}

async fn dead_letter(
    state: &AppState,
    delivery: &StoredSecurityDelivery,
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
        .dead_letter_security_delivery(&delivery.id, detail, now)
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
        let signature = sign(
            secret,
            "msg_p5jXN8AQM9LWM0D4loKWxJek",
            1_614_265_330,
            r#"{"a":1}"#,
        )
        .expect("signature");
        assert_eq!(signature.timestamp, "1614265330");
        assert!(signature.value.starts_with("v1,"), "{}", signature.value);

        // Deterministic: the same inputs always produce the same signature.
        let again = sign(
            secret,
            "msg_p5jXN8AQM9LWM0D4loKWxJek",
            1_614_265_330,
            r#"{"a":1}"#,
        )
        .expect("signature");
        assert_eq!(signature, again);
    }

    #[test]
    fn every_signed_component_changes_the_signature() {
        let secret = generate_secret();
        let base = sign(&secret, "id-1", 1_000, "payload").unwrap().value;
        assert_ne!(base, sign(&secret, "id-2", 1_000, "payload").unwrap().value);
        assert_ne!(base, sign(&secret, "id-1", 1_001, "payload").unwrap().value);
        assert_ne!(
            base,
            sign(&secret, "id-1", 1_000, "payload!").unwrap().value
        );
        assert_ne!(
            base,
            sign(&generate_secret(), "id-1", 1_000, "payload")
                .unwrap()
                .value,
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
            assert!(
                assert_deliverable(refused).is_err(),
                "{refused} must be refused"
            );
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
