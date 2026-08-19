//! Operator URL and system-event guards shared by Host and fuzz oracles.

/// Validate operator-supplied NATS URL (no http(s) — that is not the NATS protocol).
pub fn validate_nats_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("nats_url is required for nats backend".into());
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("nats://") || lower.starts_with("tls://")) {
        return Err("nats_url must start with nats:// or tls://".into());
    }
    if lower.contains(' ') {
        return Err("nats_url must not contain spaces".into());
    }
    Ok(())
}

/// Host-only system wake types (not callout-user publishable).
pub fn is_system_event_type(event_type: &str) -> bool {
    event_type.starts_with("system.")
}

/// Full JetStream subject for a CloudEvents type under the default prefix.
pub fn system_event_subject(event_type: &str) -> String {
    crate::event_subject(crate::DEFAULT_SUBJECT_PREFIX, event_type)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SYSTEM_SUBJECT_PREFIX;

    #[test]
    fn accepts_nats_and_tls_rejects_http() {
        assert!(validate_nats_url("nats://127.0.0.1:4222").is_ok());
        assert!(validate_nats_url("tls://box.tailnet.ts.net:4222").is_ok());
        assert!(validate_nats_url("http://127.0.0.1:4222").is_err());
        assert!(validate_nats_url("").is_err());
        assert!(validate_nats_url("nats://bad host:4222").is_err());
    }

    #[test]
    fn system_types_map_under_system_prefix() {
        assert!(is_system_event_type("system.backup.wake"));
        assert!(!is_system_event_type("principal.created"));
        assert!(
            system_event_subject("system.github.webhook.wake").starts_with(SYSTEM_SUBJECT_PREFIX)
        );
    }
}
