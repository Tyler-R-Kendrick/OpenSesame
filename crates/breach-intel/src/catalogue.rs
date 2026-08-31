//! The public breach catalogue, matched locally.
//!
//! Have I Been Pwned publishes the list of breaches it knows about — name,
//! domain, date, what classes of data were exposed — with no authentication
//! and nothing tenant-specific in the request. We fetch the whole list and do
//! the matching here.
//!
//! That is a deliberate alternative to the breached-account API, which answers
//! "has *this address* been breached" and therefore requires sending the
//! address. `OpenSesame` holds accounts on behalf of other people; disclosing
//! which addresses a tenant manages, to anyone, is not ours to do for a
//! convenience. Matching the catalogue against a watched domain gives the
//! operationally useful half of the answer — *your provider was breached, go
//! rotate* — and discloses nothing.
//!
//! Parsing is lenient. Every field defaults, so a catalogue entry that grows
//! or loses a key still matches on the keys we use; a source that changes
//! shape should cost coverage, not raise.

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone as _, Utc};
use opensesame_security_events::Severity;
use serde::{Deserialize, Serialize};

/// The catalogue endpoint. Unauthenticated and tenant-blind.
pub const CATALOGUE_URL: &str = "https://haveibeenpwned.com/api/v3/breaches";

/// The data class that turns a disclosure into a credential problem.
pub const PASSWORDS_CLASS: &str = "Passwords";

/// One published breach.
///
/// The field set mirrors the catalogue's published JSON one for one, flags
/// included. Collapsing the flags into a tidier enum would mean deciding, on
/// deserialization, which combinations the source is allowed to emit — and the
/// source, not us, gets to decide that. [`Breach::is_reportable`] is where the
/// combination is interpreted.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Breach {
    #[serde(rename = "Name", default)]
    pub name: String,
    #[serde(rename = "Title", default)]
    pub title: String,
    #[serde(rename = "Domain", default)]
    pub domain: String,
    #[serde(rename = "BreachDate", default)]
    pub breach_date: String,
    #[serde(rename = "AddedDate", default)]
    pub added_date: String,
    #[serde(rename = "PwnCount", default)]
    pub pwn_count: u64,
    #[serde(rename = "DataClasses", default)]
    pub data_classes: Vec<String>,
    #[serde(rename = "IsVerified", default)]
    pub is_verified: bool,
    #[serde(rename = "IsFabricated", default)]
    pub is_fabricated: bool,
    #[serde(rename = "IsSpamList", default)]
    pub is_spam_list: bool,
    #[serde(rename = "IsRetired", default)]
    pub is_retired: bool,
}

/// Parse a catalogue response.
///
/// # Errors
///
/// Returns an error when the body is not a JSON array of objects. Individual
/// entries cannot fail: every field defaults.
pub fn parse_catalogue(body: &str) -> Result<Vec<Breach>, serde_json::Error> {
    serde_json::from_str(body)
}

/// Parse one of the timestamp shapes the catalogue uses.
///
/// `AddedDate` is documented as RFC3339 but is published without seconds
/// (`2013-12-04T00:00Z`), which strict RFC3339 parsers reject. `BreachDate` is
/// a bare date. Both are accepted, and anything else yields `None` rather than
/// a guess.
#[must_use]
pub fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(exact) = DateTime::parse_from_rfc3339(raw) {
        return Some(exact.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%dT%H:%MZ", "%Y-%m-%dT%H:%M:%SZ"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, format) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|naive| Utc.from_utc_datetime(&naive))
}

/// Whether `candidate` is `domain` or a subdomain of it.
///
/// The dot is load-bearing: without it `notadobe.com` would match `adobe.com`
/// and every tenant using a lookalike host would be told their provider was
/// breached.
#[must_use]
pub fn domain_matches(candidate: &str, domain: &str) -> bool {
    let candidate = candidate.trim().trim_end_matches('.').to_ascii_lowercase();
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if candidate.is_empty() || domain.is_empty() {
        return false;
    }
    candidate == domain || candidate.ends_with(&format!(".{domain}"))
}

impl Breach {
    /// Whether this entry is solid enough to report as fact.
    ///
    /// Unverified, fabricated, and spam-list entries are excluded: telling an
    /// operator to rotate every credential at a provider is expensive, and an
    /// alert sourced from an unverified dump is how a feed loses its
    /// credibility. Retired entries are excluded because the source has
    /// withdrawn them.
    #[must_use]
    pub fn is_reportable(&self) -> bool {
        self.is_verified && !self.is_fabricated && !self.is_spam_list && !self.is_retired
    }

    /// Whether the breach exposed passwords.
    #[must_use]
    pub fn exposed_credentials(&self) -> bool {
        self.data_classes
            .iter()
            .any(|class| class.eq_ignore_ascii_case(PASSWORDS_CLASS))
    }

    /// When the source published this entry.
    #[must_use]
    pub fn added_at(&self) -> Option<DateTime<Utc>> {
        parse_timestamp(&self.added_date)
    }

    /// Whether this entry concerns `domain` or one of its subdomains.
    #[must_use]
    pub fn affects_domain(&self, domain: &str) -> bool {
        domain_matches(domain, &self.domain)
    }

    /// Operator-facing name, falling back through the fields that might be set.
    #[must_use]
    pub fn display_name(&self) -> &str {
        for candidate in [&self.title, &self.name, &self.domain] {
            if !candidate.is_empty() {
                return candidate;
            }
        }
        "unnamed breach"
    }

    /// How loud a disclosure about this breach should be.
    ///
    /// Passwords exposed is an `Error`: somebody has to rotate something
    /// today. Anything else is a `Warning` — worth knowing, not worth waking
    /// an on-call engineer.
    #[must_use]
    pub fn severity(&self) -> Severity {
        if self.exposed_credentials() {
            Severity::Error
        } else {
            Severity::Warning
        }
    }
}

/// Every reportable breach affecting `domain` that the source published after
/// `since`.
///
/// `since` is the watermark that stops a catalogue fetch from re-reporting
/// twenty years of history on every pass. `None` reports everything, which is
/// what the first pass for a newly watched domain wants.
#[must_use]
pub fn matches<'a>(
    catalogue: &'a [Breach],
    domain: &str,
    since: Option<DateTime<Utc>>,
) -> Vec<&'a Breach> {
    catalogue
        .iter()
        .filter(|breach| breach.is_reportable() && breach.affects_domain(domain))
        .filter(|breach| match (since, breach.added_at()) {
            (Some(watermark), Some(added)) => added > watermark,
            // An entry with no usable date is reported on the first pass and
            // suppressed afterwards by the finding ledger, not by this filter.
            (Some(_), None) => false,
            (None, _) => true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOGUE: &str = r#"[
      {
        "Name": "Adobe", "Title": "Adobe", "Domain": "adobe.com",
        "BreachDate": "2013-10-04", "AddedDate": "2013-12-04T00:00Z",
        "PwnCount": 152445165,
        "DataClasses": ["Email addresses", "Password hints", "Passwords"],
        "IsVerified": true, "IsFabricated": false, "IsSpamList": false,
        "IsRetired": false
      },
      {
        "Name": "Rumour", "Title": "Rumour", "Domain": "adobe.com",
        "BreachDate": "2024-01-01", "AddedDate": "2024-02-01T00:00Z",
        "PwnCount": 1, "DataClasses": ["Passwords"],
        "IsVerified": false, "IsFabricated": true, "IsSpamList": false,
        "IsRetired": false
      },
      {
        "Name": "Marketing", "Title": "Marketing List", "Domain": "example.com",
        "BreachDate": "2025-01-01", "AddedDate": "2025-02-01T00:00:00Z",
        "PwnCount": 10, "DataClasses": ["Email addresses"],
        "IsVerified": true, "IsFabricated": false, "IsSpamList": false,
        "IsRetired": false
      }
    ]"#;

    fn catalogue() -> Vec<Breach> {
        parse_catalogue(CATALOGUE).unwrap()
    }

    fn at(raw: &str) -> DateTime<Utc> {
        raw.parse().unwrap()
    }

    #[test]
    fn the_published_shape_parses() {
        let entries = catalogue();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "Adobe");
        assert_eq!(entries[0].pwn_count, 152_445_165);
    }

    #[test]
    fn an_entry_missing_every_optional_key_still_parses() {
        let sparse = parse_catalogue(r#"[{"Name": "Bare"}]"#).unwrap();
        assert_eq!(sparse[0].name, "Bare");
        assert!(!sparse[0].is_reportable(), "unverified by default");
    }

    #[test]
    fn a_body_that_is_not_a_catalogue_is_an_error() {
        assert!(parse_catalogue("not json").is_err());
    }

    #[test]
    fn the_sourced_timestamp_shapes_all_parse() {
        assert_eq!(
            parse_timestamp("2013-12-04T00:00Z"),
            Some(at("2013-12-04T00:00:00Z"))
        );
        assert_eq!(
            parse_timestamp("2013-12-04T00:00:00Z"),
            Some(at("2013-12-04T00:00:00Z"))
        );
        assert_eq!(
            parse_timestamp("2013-12-04T00:00:00+00:00"),
            Some(at("2013-12-04T00:00:00Z")),
        );
        assert_eq!(
            parse_timestamp("2013-10-04"),
            Some(at("2013-10-04T00:00:00Z"))
        );
        assert_eq!(parse_timestamp("whenever"), None);
    }

    #[test]
    fn a_subdomain_matches_but_a_lookalike_does_not() {
        assert!(domain_matches("adobe.com", "adobe.com"));
        assert!(domain_matches("id.adobe.com", "adobe.com"));
        assert!(domain_matches("ADOBE.COM", "adobe.com"));
        assert!(!domain_matches("notadobe.com", "adobe.com"));
        assert!(!domain_matches("adobe.com.evil.test", "adobe.com"));
    }

    #[test]
    fn an_empty_domain_never_matches() {
        assert!(!domain_matches("", "adobe.com"));
        assert!(!domain_matches("adobe.com", ""));
    }

    #[test]
    fn only_verified_unfabricated_entries_are_reportable() {
        let entries = catalogue();
        assert!(entries[0].is_reportable());
        assert!(
            !entries[1].is_reportable(),
            "a fabricated rumour is not fact"
        );
    }

    #[test]
    fn matching_excludes_entries_the_source_does_not_stand_behind() {
        let entries = catalogue();
        let found = matches(&entries, "id.adobe.com", None);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Adobe");
    }

    #[test]
    fn a_watermark_suppresses_history_and_admits_what_is_new() {
        let entries = catalogue();
        assert!(matches(&entries, "adobe.com", Some(at("2020-01-01T00:00:00Z"))).is_empty());
        assert_eq!(
            matches(&entries, "adobe.com", Some(at("2013-01-01T00:00:00Z"))).len(),
            1,
        );
    }

    #[test]
    fn severity_rises_when_passwords_were_exposed() {
        let entries = catalogue();
        assert_eq!(entries[0].severity(), Severity::Error);
        assert_eq!(entries[2].severity(), Severity::Warning);
    }

    #[test]
    fn a_display_name_always_resolves_to_something() {
        assert_eq!(catalogue()[0].display_name(), "Adobe");
        assert_eq!(Breach::default().display_name(), "unnamed breach");
        let domain_only = Breach {
            domain: "example.test".into(),
            ..Breach::default()
        };
        assert_eq!(domain_only.display_name(), "example.test");
    }

    #[test]
    fn an_entry_with_no_usable_date_is_suppressed_once_a_watermark_exists() {
        let undated = vec![Breach {
            name: "Undated".into(),
            domain: "example.com".into(),
            is_verified: true,
            ..Breach::default()
        }];
        assert_eq!(matches(&undated, "example.com", None).len(), 1);
        assert!(matches(&undated, "example.com", Some(at("2020-01-01T00:00:00Z"))).is_empty());
    }
}
