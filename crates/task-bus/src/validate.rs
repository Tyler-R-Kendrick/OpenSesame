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
    if url.contains('@') {
        return Err("nats_url must not embed credentials".into());
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

#[cfg(test)]
mod pact {
    use super::*;
    use crate::SYSTEM_SUBJECT_PREFIX;

    #[test]
    fn property_nats_and_tls_accepted_http_refused() {
        for ok in ["nats://127.0.0.1:4222", "tls://box.tailnet.ts.net:4222"] {
            assert!(validate_nats_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://127.0.0.1:4222",
            "https://nats.example",
            "",
            "nats://bad host:4222",
            "nats://user:secret@127.0.0.1:4222",
        ] {
            assert!(validate_nats_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn adversarial_userinfo_urls_are_refused() {
        assert!(validate_nats_url("nats://user:secret@127.0.0.1:4222").is_err());
        assert!(validate_nats_url("http://user:secret@127.0.0.1:4222").is_err());
    }

    #[test]
    fn chaos_system_types_never_leave_the_system_prefix() {
        for ty in ["system.backup.wake", "system.github.webhook.wake"] {
            assert!(is_system_event_type(ty));
            assert!(system_event_subject(ty).starts_with(SYSTEM_SUBJECT_PREFIX));
        }
        assert!(!is_system_event_type("principal.created"));
    }

    #[test]
    fn contract_validate_runs_before_connect() {
        let src = include_str!("nats.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();
        let validate = production
            .find("validate_nats_url")
            .expect("validate_nats_url");
        let connect = production
            .find("async_nats::connect")
            .expect("async_nats::connect");
        assert!(validate < connect);
    }
}
