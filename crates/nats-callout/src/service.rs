//! The bridge as a NATS micro service (the NATS Services API, ADR-32 in the
//! server's numbering).
//!
//! Registering the `$SYS.REQ.USER.AUTH` responder as a service instead of a
//! bare queue subscription buys three things without changing the protocol:
//!
//! - **Discovery.** Every instance answers `$SRV.PING|INFO|STATS` (bare,
//!   `.opensesame-auth-callout`, and `.opensesame-auth-callout.<id>`), so an
//!   operator in the callout account sees how many bridges are serving and
//!   which version each runs (`nats micro ls`).
//! - **Observability.** Per-instance request counts, processing time and the
//!   allow / deny / drop split below — reason codes and counts only, never a
//!   subject, a token or a principal.
//! - **Load balancing.** The endpoint keeps the one queue group every bridge
//!   instance shares ([`crate::QUEUE_GROUP`]), so the server hands each
//!   callout to exactly one of them; within an instance up to
//!   [`MAX_IN_FLIGHT`] callouts are decided concurrently, so one slow Host
//!   round trip no longer holds every other CONNECT behind it.
//!
//! Metadata is public by construction: the callout account's public key, the
//! target account's name, whether envelopes are sealed and how many server
//! keys are pinned. No seed, no Host URL, no certificate.
//!
//! The Services API needs the bridge user to subscribe `$SRV.>` and answer
//! its requesters (`allow_responses`); `ops/nats/secure-callout.conf` grants
//! exactly that. Without it the endpoint still serves callouts and only the
//! discovery verbs go unanswered.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_nats::service::ServiceExt as _;
use futures::StreamExt as _;
use serde_json::{json, Value};

use crate::bridge::{BridgeCore, Outcome, Verdict};
use crate::error::CalloutError;
use crate::{AUTH_SUBJECT, QUEUE_GROUP, SERVER_XKEY_HEADER};

/// Service name every bridge instance registers under.
pub const SERVICE_NAME: &str = "opensesame-auth-callout";
/// The one endpoint: answers `$SYS.REQ.USER.AUTH`.
pub const ENDPOINT_NAME: &str = "authorize";
/// Callouts one instance decides at once.
pub const MAX_IN_FLIGHT: usize = 64;

/// Allow / deny / drop counters reported in `$SRV.STATS` as endpoint `data`.
#[derive(Debug, Default)]
pub struct CalloutStats {
    allowed: AtomicU64,
    denied: AtomicU64,
    dropped: AtomicU64,
}

impl CalloutStats {
    /// Count one handled callout.
    pub fn record(&self, verdict: Verdict) {
        let counter = match verdict {
            Verdict::Allowed => &self.allowed,
            Verdict::Denied => &self.denied,
            Verdict::Dropped => &self.dropped,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    /// The `data` object of the endpoint's stats.
    #[must_use]
    pub fn snapshot(&self) -> Value {
        json!({
            "allowed": self.allowed.load(Ordering::Relaxed),
            "denied": self.denied.load(Ordering::Relaxed),
            "dropped": self.dropped.load(Ordering::Relaxed),
        })
    }
}

/// Public service metadata for this instance.
#[must_use]
pub fn metadata(core: &BridgeCore) -> HashMap<String, String> {
    HashMap::from([
        ("callout_account".into(), core.signer.account_public_key()),
        ("target_account".into(), core.target_account.clone()),
        ("sealed".into(), core.xkey.is_some().to_string()),
        (
            "pinned_servers".into(),
            core.server_public_keys.len().to_string(),
        ),
    ])
}

/// Register the service and serve its endpoint until the subscription ends.
///
/// # Errors
///
/// `MalformedConfiguration` when the service or endpoint cannot be added.
pub async fn serve(client: async_nats::Client, core: Arc<BridgeCore>) -> Result<(), CalloutError> {
    let stats = Arc::new(CalloutStats::default());
    let reported = Arc::clone(&stats);
    let service = client
        .service_builder()
        .description("OpenSesame NATS auth-callout bridge")
        .metadata(metadata(&core))
        .queue_group(QUEUE_GROUP)
        .stats_handler(move |_endpoint, _stats| reported.snapshot())
        .start(SERVICE_NAME, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(|e| crate::error::misconfigured(format!("register {SERVICE_NAME}: {e}")))?;
    let endpoint = service
        .endpoint_builder()
        .name(ENDPOINT_NAME)
        .add(AUTH_SUBJECT)
        .await
        .map_err(|e| crate::error::misconfigured(format!("subscribe {AUTH_SUBJECT}: {e}")))?;
    tracing::info!(
        service = SERVICE_NAME,
        subject = AUTH_SUBJECT,
        queue = QUEUE_GROUP,
        max_in_flight = MAX_IN_FLIGHT,
        "auth bridge serving"
    );
    endpoint
        .for_each_concurrent(MAX_IN_FLIGHT, |request| serve_one(&core, &stats, request))
        .await;
    // Keep the service (and its discovery verbs) registered for as long as
    // the endpoint serves.
    drop(service);
    Ok(())
}

/// One callout: verify, decide, answer. A payload that does not verify gets
/// no answer at all — there is no user key to address it to.
async fn serve_one(core: &BridgeCore, stats: &CalloutStats, request: async_nats::service::Request) {
    let header = request
        .message
        .headers
        .as_ref()
        .and_then(|h| h.get(SERVER_XKEY_HEADER))
        .map(|v| v.as_str().to_owned());
    let now = chrono::Utc::now().timestamp();
    let (outcome, verdict) = core
        .handle_with_verdict(&request.message.payload, header.as_deref(), now)
        .await;
    stats.record(verdict);
    match outcome {
        Outcome::Reply(bytes) => {
            // A failure is logged, never retried: the server times the client
            // out, which is itself a deny.
            if let Err(e) = request.respond(Ok(bytes.into())).await {
                tracing::warn!(error = %e, "callout reply publish failed");
            }
        }
        Outcome::Dropped(err) => tracing::warn!(code = err.code(), "callout dropped"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_count_each_verdict() {
        let stats = CalloutStats::default();
        stats.record(Verdict::Allowed);
        stats.record(Verdict::Allowed);
        stats.record(Verdict::Denied);
        stats.record(Verdict::Dropped);
        assert_eq!(
            stats.snapshot(),
            json!({"allowed": 2, "denied": 1, "dropped": 1})
        );
    }

    #[test]
    fn service_name_is_a_valid_micro_name() {
        assert!(SERVICE_NAME
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }
}
