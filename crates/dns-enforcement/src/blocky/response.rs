//! What Blocky sends back, and the three ways a query can end.
//!
//! The parsers are strict on the fields this crate reads: a body missing
//! `enabled`, or a query outcome missing `responseType`, is an error rather than
//! a default, because both defaults would read as "nothing is blocked".

use serde::{Deserialize, Serialize};

use super::{ProtocolError, RESPONSE_TYPE_BLOCKED};
use crate::scope::DomainRule;

/// Blocky's answer to `blocking/status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockingStatus {
    /// Whether blocking is on.
    pub enabled: bool,
    /// The groups currently disabled.
    pub disabled_groups: Vec<String>,
    /// Seconds until Blocky re-enables them itself, when it will.
    pub auto_enable_in_sec: Option<i64>,
}

impl BlockingStatus {
    /// Whether this status is the measured signature of a bare, group-less
    /// disable: filtering off, with nothing scheduled to turn it back on.
    ///
    /// A caller that finds this true is looking at an instance somebody switched
    /// off — by hand, or through the mapping this crate refuses to make — and
    /// should treat its units as unenforced rather than as healthy.
    #[must_use]
    pub const fn is_indefinitely_disabled(&self) -> bool {
        !self.enabled && self.auto_enable_in_sec.is_none()
    }
}

/// Blocky's answer to `query`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryOutcome {
    /// Blocky's own explanation, e.g. `BLOCKED (unit-alpha: blocked.example.org)`.
    pub reason: String,
    /// The rendered response, e.g. `A (0.0.0.0)`.
    pub response: String,
    /// The response type, e.g. `BLOCKED`, `CACHED`, `CUSTOMDNS`.
    pub response_type: String,
    /// The DNS return code, e.g. `NOERROR`.
    pub return_code: String,
}

impl QueryOutcome {
    /// Whether the name was refused by a denylist.
    ///
    /// Only `BLOCKED` counts. `FILTERED` and `NOTFQDN` are query-type rejections,
    /// `SPECIAL` is a special-use domain, and a resolver error is a failure to
    /// answer — reading any of those as a block would report the filter working
    /// when it had not run.
    #[must_use]
    pub fn is_blocked(&self) -> bool {
        self.response_type == RESPONSE_TYPE_BLOCKED
    }
}

/// What came back from a `query`.
///
/// The second case is the one that needs a name. A name the filter *admits* is
/// forwarded upstream, so if the upstream is unreachable Blocky answers
/// `HTTP 500` — and reading that as "DNS enforcement is unavailable" would be
/// wrong twice over: the filter ran, and it let the name through. The filter
/// verdict and the resolution outcome are two facts, and this enum keeps them
/// apart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Blocky decided and answered.
    Answered(QueryOutcome),
    /// The filter did not block the name, and resolving it past the filter
    /// failed. There is no address, and there was no block.
    AdmittedButUnresolved {
        /// Blocky's own explanation, for an operator log.
        detail: String,
    },
}

impl Resolution {
    /// Whether a denylist refused the name.
    ///
    /// [`Self::AdmittedButUnresolved`] is `false`: the filter admitted it. A
    /// caller asking "did the filter stop this" gets the filter's answer, not the
    /// network's.
    #[must_use]
    pub fn is_blocked(&self) -> bool {
        match self {
            Self::Answered(outcome) => outcome.is_blocked(),
            Self::AdmittedButUnresolved { .. } => false,
        }
    }

    /// The outcome, when Blocky answered with one.
    #[must_use]
    pub const fn answered(&self) -> Option<&QueryOutcome> {
        match self {
            Self::Answered(outcome) => Some(outcome),
            Self::AdmittedButUnresolved { .. } => None,
        }
    }
}

/// Whether a failed `query` response is Blocky reporting that it admitted the
/// name and could not resolve it.
///
/// This reads Blocky's error prose, because the API offers no structured signal
/// for it — the status is `500` either way. Both markers are required, so an
/// unrelated `500` stays a capability gap rather than being read as an admitted
/// name. Pinned to [`super::PINNED_VERSION`] and covered by the protocol tests,
/// which is what would catch the wording changing.
#[must_use]
pub fn admitted_but_unresolved(body: &str) -> Option<String> {
    let looks_like_query_failure =
        body.contains("query failed for") && body.contains("query resolution failed");
    looks_like_query_failure.then(|| body.trim().to_owned())
}

/// Read a `blocking/status` body.
///
/// # Errors
///
/// Returns [`ProtocolError::Unreadable`] when the body is not this version's
/// JSON.
pub fn parse_status(body: &str) -> Result<BlockingStatus, ProtocolError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| ProtocolError::Unreadable {
            detail: e.to_string(),
        })?;
    let enabled = value
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| ProtocolError::Unreadable {
            detail: "`enabled` missing or not a boolean".to_owned(),
        })?;
    let disabled_groups = value
        .get("disabledGroups")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let auto_enable_in_sec = value
        .get("autoEnableInSec")
        .and_then(serde_json::Value::as_i64);

    Ok(BlockingStatus {
        enabled,
        disabled_groups,
        auto_enable_in_sec,
    })
}

/// Read a `query` body.
///
/// # Errors
///
/// Returns [`ProtocolError::Unreadable`] when a field this crate reads is
/// missing — a partial outcome would otherwise be read as "not blocked".
pub fn parse_query(body: &str) -> Result<QueryOutcome, ProtocolError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| ProtocolError::Unreadable {
            detail: e.to_string(),
        })?;
    let field = |name: &str| -> Result<String, ProtocolError> {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| ProtocolError::Unreadable {
                detail: format!("`{name}` missing or not a string"),
            })
    };
    Ok(QueryOutcome {
        reason: field("reason")?,
        response: field("response")?,
        response_type: field("responseType")?,
        return_code: field("returnCode")?,
    })
}

/// Render a unit's allowlist file.
///
/// One name per line, with a generated-file header. The rules are already
/// normalised and charset-checked by [`DomainRule`], so no entry here can carry a
/// comment marker, a newline, or anything else that would turn one line into two.
#[must_use]
pub fn allowlist_document(rules: &[DomainRule]) -> String {
    let mut out = String::from("# generated by opensesame-dns-enforcement; do not edit\n");
    for rule in rules {
        out.push_str(rule.as_str());
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        admitted_but_unresolved, allowlist_document, parse_query, parse_status, ProtocolError,
        Resolution,
    };
    use crate::scope::DomainRule;

    #[test]
    fn status_parses_the_shapes_this_version_returns() {
        // Enabled: the other fields are absent, not null.
        let enabled = parse_status(r#"{"enabled":true}"#).expect("parse");
        assert!(enabled.enabled);
        assert!(enabled.disabled_groups.is_empty());
        assert!(!enabled.is_indefinitely_disabled());

        // The measured signature of a bare disable.
        let bare = parse_status(
            r#"{"disabledGroups":["default","unit-alpha","unit-beta"],"enabled":false}"#,
        )
        .expect("parse");
        assert_eq!(bare.disabled_groups.len(), 3);
        assert!(bare.is_indefinitely_disabled());

        // A scoped disable with a window is not the same condition.
        let scoped = parse_status(
            r#"{"autoEnableInSec":29,"disabledGroups":["unit-alpha"],"enabled":false}"#,
        )
        .expect("parse");
        assert_eq!(scoped.auto_enable_in_sec, Some(29));
        assert!(!scoped.is_indefinitely_disabled());
    }

    #[test]
    fn a_body_missing_enabled_is_an_error_not_a_default() {
        assert!(matches!(
            parse_status("{}"),
            Err(ProtocolError::Unreadable { .. })
        ));
        assert!(matches!(
            parse_status("not json"),
            Err(ProtocolError::Unreadable { .. })
        ));
    }

    #[test]
    fn only_blocked_counts_as_blocked() {
        let blocked = parse_query(
            r#"{"reason":"BLOCKED (unit-alpha: blocked.example.org)","response":"A (0.0.0.0)","responseType":"BLOCKED","returnCode":"NOERROR"}"#,
        )
        .expect("parse");
        assert!(blocked.is_blocked());

        // Measured while blocking was disabled: a special-use domain answers
        // NXDOMAIN, which is not the filter doing anything.
        let special = parse_query(
            r#"{"reason":"Special-Use Domain Name","response":"","responseType":"SPECIAL","returnCode":"NXDOMAIN"}"#,
        )
        .expect("parse");
        assert!(!special.is_blocked());

        // And customDNS answers before blocking runs at all.
        let custom = parse_query(
            r#"{"reason":"CUSTOM DNS","response":"A (10.0.0.8)","responseType":"CUSTOMDNS","returnCode":"NOERROR"}"#,
        )
        .expect("parse");
        assert!(!custom.is_blocked());
    }

    #[test]
    fn an_admitted_name_whose_upstream_failed_is_not_a_block_and_not_a_gap() {
        // Measured body: allowlisting a name makes Blocky forward it, so a dead
        // upstream answers HTTP 500. The filter ran and admitted the name.
        let body = "query failed for 'both.example.org' (type A): query resolution failed: \
                    failed to resolve allowlisted domain both.example.org: upstream \
                    'tcp+udp:127.0.0.1:55999': connection refused";
        let detail = admitted_but_unresolved(body).expect("should classify as admitted");
        let resolution = Resolution::AdmittedButUnresolved { detail };
        assert!(!resolution.is_blocked());
        assert!(resolution.answered().is_none());
    }

    #[test]
    fn an_unrelated_failure_is_not_read_as_an_admitted_name() {
        // Both markers are required, so a 500 that means something else stays a
        // capability gap rather than quietly becoming "not blocked".
        assert!(admitted_but_unresolved("internal server error").is_none());
        assert!(admitted_but_unresolved("query failed for 'x'").is_none());
        assert!(admitted_but_unresolved("").is_none());
    }

    #[test]
    fn an_answered_resolution_reports_the_filters_verdict() {
        let outcome = parse_query(
            r#"{"reason":"BLOCKED (unit-alpha: blocked.example.org)","response":"A (0.0.0.0)","responseType":"BLOCKED","returnCode":"NOERROR"}"#,
        )
        .expect("parse");
        let resolution = Resolution::Answered(outcome);
        assert!(resolution.is_blocked());
        assert!(resolution.answered().is_some());
    }

    #[test]
    fn a_partial_query_body_is_an_error_rather_than_not_blocked() {
        assert!(matches!(
            parse_query(r#"{"reason":"BLOCKED"}"#),
            Err(ProtocolError::Unreadable { .. })
        ));
    }

    #[test]
    fn an_allowlist_document_is_one_checked_name_per_line() {
        let rules = [
            DomainRule::parse("api.example.org").expect("rule"),
            DomainRule::parse("docs.example.org").expect("rule"),
        ];
        let document = allowlist_document(&rules);
        assert_eq!(
            document,
            "# generated by opensesame-dns-enforcement; do not edit\napi.example.org\ndocs.example.org\n"
        );
        // An empty allowlist is a real state — the revoked one — and renders as
        // the header alone rather than as a missing file.
        assert_eq!(
            allowlist_document(&[]),
            "# generated by opensesame-dns-enforcement; do not edit\n"
        );
    }
}
