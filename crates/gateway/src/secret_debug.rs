//! `Debug` for the request bodies that carry a plaintext secret (ADR 0157).
//!
//! `#[derive(Debug)]` prints every field, so a body holding a secret would put
//! it in any `{:?}`, `tracing` field or panic message handed the body. Each
//! impl here prints what is metadata and `[REDACTED]` for what is not. They sit
//! in one module, beside neither route, because the route files are at their
//! size ledger (ADR 0093); the route modules are `pub(crate)` so these can
//! name the types.

use std::fmt;

use crate::routes::est_server::EstConfigBody;
use crate::routes::lifecycle::HookBody;
use crate::routes::security::CheckRequest;

impl fmt::Debug for HookBody {
    /// `secret` is a `PagerDuty` routing key or a bearer for an Alertmanager proxy.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HookBody")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("event_types", &self.event_types)
            .field("endpoint_url", &self.endpoint_url)
            .field("delivery", &self.delivery)
            .field("subject_kinds", &self.subject_kinds)
            .field("severity_min", &self.severity_min)
            .field("secret", &self.secret.as_ref().map(|_| "[REDACTED]"))
            .field("enabled", &self.enabled)
            .finish()
    }
}

impl fmt::Debug for CheckRequest {
    /// `secret` is the candidate value under test.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CheckRequest")
            .field("secret", &"[REDACTED]")
            .field("subject_id", &self.subject_id)
            .field("subject_kind", &self.subject_kind)
            .finish()
    }
}

impl fmt::Debug for EstConfigBody {
    /// `passphrase` is the bootstrap passphrase; the chain is public PEM.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EstConfigBody")
            .field(
                "passphrase",
                &self.passphrase.as_ref().map(|_| "[REDACTED]"),
            )
            .field("bootstrap_chain_pem", &self.bootstrap_chain_pem)
            .field("require_bootstrap", &self.require_bootstrap)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hook_body_prints_no_sink_secret() {
        let body: HookBody = serde_json::from_str(
            r#"{"name":"pd","event_types":["*"],"endpoint_url":"https://events.example","secret":"routing-key-12345"}"#,
        )
        .unwrap();
        let shown = format!("{body:?}");
        assert!(shown.contains("[REDACTED]"), "{shown}");
        assert!(!shown.contains("routing-key-12345"), "{shown}");
        assert!(shown.contains("events.example"), "{shown}");
    }

    #[test]
    fn a_breach_check_request_prints_no_candidate() {
        let body: CheckRequest =
            serde_json::from_str(r#"{"secret":"candidate-12345","subject_id":"Dev/db"}"#).unwrap();
        let shown = format!("{body:?}");
        assert!(shown.contains("[REDACTED]"), "{shown}");
        assert!(!shown.contains("candidate-12345"), "{shown}");
        assert!(shown.contains("Dev/db"), "{shown}");
    }

    #[test]
    fn an_est_config_body_prints_no_passphrase() {
        let body: EstConfigBody =
            serde_json::from_str(r#"{"passphrase":"bootstrap-12345","require_bootstrap":true}"#)
                .unwrap();
        let shown = format!("{body:?}");
        assert!(shown.contains("[REDACTED]"), "{shown}");
        assert!(!shown.contains("bootstrap-12345"), "{shown}");
        assert!(shown.contains("require_bootstrap: true"), "{shown}");
    }
}
