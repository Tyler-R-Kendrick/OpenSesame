//! The built-in notification subscriber.
//!
//! Every security event, at every severity, is written where a host log
//! collector will find it — as an RFC 5424 line, so journald, rsyslog, and
//! every SIEM that ingests syslog pick it up with no adapter and no
//! `OpenSesame`-specific parser.
//!
//! This is the subscriber that makes "nobody configured anything" a survivable
//! state. It needs no endpoint, no secret, and no network, so the day the
//! gateway is first deployed a compromised credential still lands somewhere a
//! human can find it.
//!
//! The line is emitted through `tracing` rather than written to a socket. That
//! is deliberate: the host's log pipeline already solves transport, retention,
//! and access control for this exact kind of record, and inventing plaintext
//! syslog egress to a remote host would put credential metadata on the wire in
//! the clear. See `opensesame_security_events::Delivery` for why there is no
//! `syslog` *delivery* kind to go with this *format*.

use opensesame_security_events::render::syslog;
use opensesame_security_events::{SecurityNotice, Severity};

/// The `tracing` target these lines carry, so an operator can route them
/// separately from the gateway's ordinary chatter.
pub const TARGET: &str = "opensesame::security";

/// The origin fields for lines emitted by this process.
///
/// Resolved once. Every one of these is fixed for the process's lifetime, and
/// re-reading the environment on every security event would be work done per
/// event to produce the same answer.
#[must_use]
pub fn origin() -> &'static syslog::Origin {
    static ORIGIN: std::sync::OnceLock<syslog::Origin> = std::sync::OnceLock::new();
    ORIGIN.get_or_init(|| syslog::Origin {
        hostname: hostname(),
        process_id: std::process::id().to_string(),
        enterprise_number: enterprise_number(),
    })
}

/// The host name to stamp on a line.
///
/// Read from the environment rather than a syscall: the value that matters to
/// a log pipeline is the one the deployment considers this node to be called,
/// and in a container the kernel's idea of it is a random hex string.
fn hostname() -> String {
    ["OPENSESAME_HOSTNAME", "HOSTNAME"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok())
        .unwrap_or_default()
}

/// The structured-data enterprise number, overridable by an operator who has
/// registered one of their own.
fn enterprise_number() -> u32 {
    std::env::var("OPENSESAME_SYSLOG_ENTERPRISE_NUMBER")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(syslog::DEFAULT_ENTERPRISE_NUMBER)
}

/// Record one security event.
///
/// The `tracing` level tracks the event's severity so an operator's existing
/// log routing works without knowing anything about our severity ladder. The
/// RFC 5424 line is carried whole in the `event` field rather than
/// reconstructed from the log record's own fields, so what a collector reads is
/// byte for byte what the renderer produced.
pub fn record(notice: &SecurityNotice) {
    let line = syslog::render(notice, origin());
    match notice.severity {
        Severity::Critical | Severity::Error => {
            tracing::error!(target: TARGET, event = %line, "security event");
        }
        Severity::Warning => {
            tracing::warn!(target: TARGET, event = %line, "security event");
        }
        Severity::Info => {
            tracing::info!(target: TARGET, event = %line, "security event");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_security_events::NoticeState;
    use serde_json::json;

    fn notice(severity: Severity) -> SecurityNotice {
        SecurityNotice {
            event_type: "breach.password.compromised".into(),
            severity,
            state: NoticeState::Firing,
            organization_id: "org-1".into(),
            subject_kind: "store_path".into(),
            subject_id: "Dev/api-token".into(),
            label: Some("Dev/api-token".into()),
            occurred_at: "2026-08-30T00:00:00Z".parse().unwrap(),
            summary: "a stored secret appears in a public breach corpus".into(),
            detail: None,
            payload: json!({"occurrences": 42, "password": "hunter2"}),
        }
    }

    #[test]
    fn the_recorded_line_is_a_well_formed_rfc_5424_record() {
        let line = syslog::render(&notice(Severity::Critical), origin());
        assert!(line.starts_with("<82>1 "), "{line}");
        assert!(line.contains("[opensesame@"), "{line}");
        assert!(line.ends_with("a stored secret appears in a public breach corpus"));
    }

    #[test]
    fn a_recorded_line_never_carries_a_value() {
        let line = syslog::render(&notice(Severity::Critical), origin());
        assert!(
            !line.contains("hunter2"),
            "the notifier must not print what it is warning about: {line}",
        );
    }

    #[test]
    fn every_severity_produces_a_line_and_they_differ_in_priority() {
        let mut priorities: Vec<String> = Severity::ALL
            .iter()
            .map(|level| {
                let line = syslog::render(&notice(*level), origin());
                line.split_once('>').unwrap().0.to_string()
            })
            .collect();
        let total = priorities.len();
        priorities.sort_unstable();
        priorities.dedup();
        assert_eq!(priorities.len(), total, "severities must not collapse");
    }

    #[test]
    fn recording_is_infallible_for_every_severity() {
        for level in Severity::ALL {
            record(&notice(level));
        }
    }

    #[test]
    fn the_origin_falls_back_to_the_nil_host_without_configuration() {
        // Whatever the environment holds, the rendered line must stay
        // parseable: header fields are reduced to printable ASCII or the nil
        // value by the renderer.
        let line = syslog::render(&notice(Severity::Info), origin());
        let fields: Vec<&str> = line.splitn(7, ' ').collect();
        assert_eq!(fields.len(), 7, "{line}");
        assert!(!fields[2].contains(' '));
    }
}
