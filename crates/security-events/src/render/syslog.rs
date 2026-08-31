//! RFC 5424 syslog rendering.
//!
//! The lowest-common-denominator sink, and the reason it is here: every SIEM
//! and log pipeline in existence ingests syslog, so an operator with no
//! Alertmanager and no `PagerDuty` still has somewhere for a security event to
//! land. A line is emitted whole — priority, structured data, message — so it
//! can be handed to a relay or written to a socket without further assembly.
//!
//! Facility is `authpriv` (10). These are private authorization events: they
//! concern credentials and authority, and most default syslog configurations
//! route `authpriv` somewhere more restricted than general application logs,
//! which is where they belong.

use crate::notice::SecurityNotice;

/// RFC 5424 facility: `authpriv`, security/authorization messages (private).
pub const FACILITY: u8 = 10;
/// The version every RFC 5424 line carries.
pub const VERSION: u8 = 1;
/// `APP-NAME` field.
pub const APP_NAME: &str = "opensesame";

/// Enterprise number used in the structured-data id.
///
/// 32473 is IANA's number reserved for documentation and examples (RFC 5612).
/// It is a deliberate placeholder: an SD-ID must be enterprise-scoped, and
/// borrowing somebody else's registered number would be worse than admitting
/// we do not have one. Operators who have registered a number override it.
pub const DEFAULT_ENTERPRISE_NUMBER: u32 = 32_473;

/// Longest `HOSTNAME` RFC 5424 allows.
const MAX_HOSTNAME_CHARS: usize = 255;
/// Longest `APP-NAME`, `PROCID`, and `MSGID` RFC 5424 allows.
const MAX_NAME_CHARS: usize = 48;
/// The field value meaning "nothing to report".
const NIL: &str = "-";

/// Where the line comes from and how it identifies itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    /// `HOSTNAME`. Empty renders as the nil value.
    pub hostname: String,
    /// `PROCID`. Empty renders as the nil value.
    pub process_id: String,
    /// Enterprise number for the structured-data id.
    pub enterprise_number: u32,
}

impl Default for Origin {
    fn default() -> Self {
        Self {
            hostname: String::new(),
            process_id: String::new(),
            enterprise_number: DEFAULT_ENTERPRISE_NUMBER,
        }
    }
}

impl Origin {
    /// The structured-data id these lines carry.
    #[must_use]
    pub fn sd_id(&self) -> String {
        format!("{APP_NAME}@{}", self.enterprise_number)
    }
}

/// Computed priority value: `facility * 8 + severity`.
#[must_use]
pub fn priority(notice: &SecurityNotice) -> u8 {
    FACILITY * 8 + notice.severity.syslog_code()
}

/// A header field, reduced to the printable US-ASCII RFC 5424 permits and
/// bounded to its field length. An empty result becomes the nil value, which
/// is what the grammar wants for "unknown" — a malformed field would make the
/// whole line unparseable to a strict collector.
fn header_field(raw: &str, max_chars: usize) -> String {
    let cleaned: String = raw
        .chars()
        .filter(char::is_ascii_graphic)
        .take(max_chars)
        .collect();
    if cleaned.is_empty() {
        NIL.to_string()
    } else {
        cleaned
    }
}

/// Replace every control character with a space.
///
/// RFC 5424 does not forbid them, but every transport that carries these lines
/// is line-oriented, and a newline inside a value would end the record early —
/// letting whatever follows be read as a *second*, forged log line. Labels come
/// from operator-supplied names (a certificate's common name, a store path), so
/// this is reachable input, not a hypothetical.
///
/// Replaced rather than dropped so the surrounding text stays readable and a
/// removal cannot silently join two words into a different one.
fn strip_controls(raw: &str) -> String {
    raw.chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

/// Escape an `SD-PARAM` value: RFC 5424 §6.3.3 requires `"`, `\`, and `]` to
/// be backslash-escaped, and nothing else to be. Control characters are
/// neutralized first, for the reason in [`strip_controls`].
fn escape_param(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len());
    for character in strip_controls(raw).chars() {
        if matches!(character, '"' | '\\' | ']') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn param(name: &str, value: &str) -> String {
    format!(" {name}=\"{}\"", escape_param(value))
}

/// The structured-data element carrying the event's metadata.
fn structured_data(notice: &SecurityNotice, origin: &Origin) -> String {
    let mut element = format!("[{}", origin.sd_id());
    element.push_str(&param("eventType", &notice.event_type));
    element.push_str(&param("severity", notice.severity.as_str()));
    element.push_str(&param("state", notice.state.as_str()));
    element.push_str(&param("organization", &notice.organization_id));
    element.push_str(&param("subjectKind", &notice.subject_kind));
    element.push_str(&param("subjectId", &notice.subject_id));
    element.push_str(&param("alertKey", &notice.alert_key()));
    if let Some(label) = notice.label_text() {
        element.push_str(&param("subjectLabel", &label));
    }
    if let Some(detail) = notice.detail_text() {
        element.push_str(&param("detail", &detail));
    }
    element.push(']');
    element
}

/// Render one notice as a complete RFC 5424 line.
///
/// The message body is the summary and carries no leading BOM: a BOM tells a
/// collector the message is UTF-8, and every summary we build is bounded ASCII
/// metadata plus operator-supplied labels. Collectors treat a BOM-less MSG as
/// unknown-encoding bytes, which is the honest claim.
#[must_use]
pub fn render(notice: &SecurityNotice, origin: &Origin) -> String {
    format!(
        "<{}>{VERSION} {} {} {APP_NAME} {} {} {} {}",
        priority(notice),
        notice.occurred_at.to_rfc3339(),
        header_field(&origin.hostname, MAX_HOSTNAME_CHARS),
        header_field(&origin.process_id, MAX_NAME_CHARS),
        header_field(notice.family(), MAX_NAME_CHARS),
        structured_data(notice, origin),
        strip_controls(&notice.summary_text()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notice::NoticeState;
    use crate::severity::Severity;
    use serde_json::json;

    fn notice() -> SecurityNotice {
        SecurityNotice {
            event_type: "breach.password.compromised".into(),
            severity: Severity::Critical,
            state: NoticeState::Firing,
            organization_id: "org-1".into(),
            subject_kind: "store_path".into(),
            subject_id: "Dev/api-token".into(),
            label: Some("Dev/api-token".into()),
            occurred_at: "2026-08-30T00:00:00Z".parse().unwrap(),
            summary: "a stored secret appears in a public breach corpus".into(),
            detail: None,
            payload: json!({"occurrences": 42}),
        }
    }

    fn origin() -> Origin {
        Origin {
            hostname: "host-1".into(),
            process_id: "4242".into(),
            enterprise_number: DEFAULT_ENTERPRISE_NUMBER,
        }
    }

    #[test]
    fn the_line_opens_with_a_computed_priority_and_version() {
        let line = render(&notice(), &origin());
        // authpriv (10) * 8 + critical (2) = 82.
        assert!(line.starts_with("<82>1 "), "{line}");
    }

    #[test]
    fn priority_tracks_severity() {
        for level in Severity::ALL {
            let mut at = notice();
            at.severity = level;
            assert_eq!(priority(&at), FACILITY * 8 + level.syslog_code());
        }
    }

    #[test]
    fn the_header_carries_every_field_in_order() {
        let line = render(&notice(), &origin());
        let fields: Vec<&str> = line.splitn(7, ' ').collect();
        assert_eq!(fields[0], "<82>1");
        assert_eq!(fields[1], "2026-08-30T00:00:00+00:00");
        assert_eq!(fields[2], "host-1");
        assert_eq!(fields[3], APP_NAME);
        assert_eq!(fields[4], "4242");
        assert_eq!(fields[5], "breach", "MSGID is the event family");
        assert!(fields[6].starts_with("[opensesame@32473 "));
    }

    #[test]
    fn empty_header_fields_become_the_nil_value() {
        let line = render(&notice(), &Origin::default());
        assert!(line.contains(" - opensesame - breach ["), "{line}");
    }

    #[test]
    fn header_fields_are_reduced_to_printable_ascii() {
        let mut hostile = origin();
        hostile.hostname = "bad host\nwith\tcontrol".into();
        let line = render(&notice(), &hostile);
        assert!(line.contains(" badhostwithcontrol "), "{line}");
        assert!(!line.contains('\n'));
        assert!(!line.contains('\t'));
    }

    #[test]
    fn structured_data_values_are_escaped() {
        let mut hostile = notice();
        hostile.label = Some(r#"quote" backslash\ bracket]"#.into());
        let line = render(&hostile, &origin());
        assert!(
            line.contains(r#"subjectLabel="quote\" backslash\\ bracket\]""#),
            "{line}",
        );
    }

    #[test]
    fn an_injected_element_cannot_close_the_structured_data_early() {
        let mut hostile = notice();
        hostile.subject_id = r#"x] [evil@1 a="b"#.into();
        let line = render(&hostile, &origin());
        assert!(
            line.contains(r#"subjectId="x\] [evil@1 a=\"b""#),
            "a forged element must survive only as escaped text: {line}",
        );
        // Exactly one unescaped `]` in the line: the one that closes our own
        // element. A parser therefore sees one element, not two.
        let unescaped = line
            .char_indices()
            .filter(|(index, character)| *character == ']' && !line[..*index].ends_with('\\'))
            .count();
        assert_eq!(unescaped, 1, "{line}");
    }

    #[test]
    fn a_newline_in_a_summary_cannot_forge_a_second_record() {
        let mut hostile = notice();
        hostile.summary = "benign\n<34>1 2026-08-30T00:00:00Z evil - - - forged".into();
        let line = render(&hostile, &origin());
        assert_eq!(line.lines().count(), 1, "{line}");
        assert!(!line.contains('\n'));
        assert!(line.contains("benign <34>1"), "{line}");
    }

    #[test]
    fn control_characters_in_a_label_cannot_break_the_record() {
        let mut hostile = notice();
        hostile.label = Some("api\r\n<34>1 forged".into());
        let line = render(&hostile, &origin());
        assert_eq!(line.lines().count(), 1, "{line}");
        assert!(!line.contains('\r'));
    }

    #[test]
    fn a_tab_in_a_detail_does_not_split_the_header_fields() {
        let mut hostile = notice();
        hostile.detail = Some("a\tb".into());
        let line = render(&hostile, &origin());
        assert!(line.contains(r#"detail="a b""#), "{line}");
    }

    #[test]
    fn the_summary_is_the_message_body() {
        let line = render(&notice(), &origin());
        assert!(line.ends_with("a stored secret appears in a public breach corpus"));
    }

    #[test]
    fn a_resolved_notice_says_so_in_its_structured_data() {
        let mut settled = notice();
        settled.state = NoticeState::Resolved;
        assert!(render(&settled, &origin()).contains(r#"state="resolved""#));
    }

    #[test]
    fn the_enterprise_number_is_configurable() {
        let mut registered = origin();
        registered.enterprise_number = 12_345;
        assert!(render(&notice(), &registered).contains("[opensesame@12345 "));
    }
}
