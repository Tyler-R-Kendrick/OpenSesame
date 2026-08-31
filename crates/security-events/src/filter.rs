//! Subscription filters over event names.
//!
//! One implementation, shared by every event family. When expiry had the only
//! feed its filter understood one wildcard, `lifecycle.*`; a second family
//! needs `breach.*` to work identically, and a third must not require a third
//! edit. So a wildcard here is `<family>.*` for any family, plus a bare `*`
//! for a subscriber that genuinely wants everything the platform detects.
//!
//! An empty filter matches nothing. A hook that names no events is a
//! misconfiguration, and reading it as "everything" is the wrong direction to
//! fail: it turns a typo into an unexpected firehose pointed at somebody's
//! endpoint.

/// Subscription wildcard for every security event, of every family.
pub const WILDCARD_ALL: &str = "*";
/// The suffix that makes an entry a family wildcard.
pub const WILDCARD_SUFFIX: &str = ".*";

/// The family a wildcard entry selects, or `None` when it is not a wildcard.
///
/// [`WILDCARD_ALL`] returns `Some("")`, which no event type's family can equal,
/// so it is handled by [`matches`] rather than by pretending to be a family.
#[must_use]
pub fn wildcard_family(entry: &str) -> Option<&str> {
    if entry == WILDCARD_ALL {
        return Some("");
    }
    entry.strip_suffix(WILDCARD_SUFFIX)
}

/// The family of an event type — the segment before its first dot.
#[must_use]
pub fn family_of(event_type: &str) -> &str {
    event_type
        .split_once('.')
        .map_or(event_type, |(family, _)| family)
}

/// Whether one filter entry selects `event_type`.
#[must_use]
pub fn entry_matches(entry: &str, event_type: &str) -> bool {
    if entry == event_type || entry == WILDCARD_ALL {
        return true;
    }
    wildcard_family(entry)
        .is_some_and(|family| !family.is_empty() && family == family_of(event_type))
}

/// Whether a subscription filter selects `event_type`.
#[must_use]
pub fn matches(filter: &[String], event_type: &str) -> bool {
    filter.iter().any(|entry| entry_matches(entry, event_type))
}

/// Whether every entry in a filter is a name the platform recognises.
///
/// `known` is the union of every family's frozen event types. A family
/// wildcard is accepted only when that family actually has events, so
/// subscribing to `breach.*` in a build without the breach detector is refused
/// at registration rather than silently delivering nothing forever.
#[must_use]
pub fn is_valid(filter: &[String], known: &[&str]) -> bool {
    !filter.is_empty()
        && filter.iter().all(|entry| {
            if entry == WILDCARD_ALL || known.contains(&entry.as_str()) {
                return true;
            }
            wildcard_family(entry).is_some_and(|family| {
                !family.is_empty() && known.iter().any(|event| family_of(event) == family)
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: &[&str] = &[
        "lifecycle.expiry.notice",
        "lifecycle.renewal.due",
        "breach.password.compromised",
        "breach.scan.failed",
    ];

    fn filter(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| (*entry).to_string()).collect()
    }

    #[test]
    fn an_exact_entry_matches_only_itself() {
        let subscription = filter(&["lifecycle.renewal.due"]);
        assert!(matches(&subscription, "lifecycle.renewal.due"));
        assert!(!matches(&subscription, "lifecycle.expiry.notice"));
    }

    #[test]
    fn a_family_wildcard_matches_its_own_family_only() {
        let subscription = filter(&["breach.*"]);
        assert!(matches(&subscription, "breach.password.compromised"));
        assert!(matches(&subscription, "breach.scan.failed"));
        assert!(
            !matches(&subscription, "lifecycle.renewal.due"),
            "breach.* must not quietly become everything",
        );
    }

    #[test]
    fn the_bare_wildcard_matches_every_family() {
        let subscription = filter(&[WILDCARD_ALL]);
        for event in KNOWN {
            assert!(matches(&subscription, event), "{event}");
        }
    }

    #[test]
    fn a_family_prefix_does_not_match_a_longer_family() {
        assert!(!entry_matches("breach.*", "breachy.password.compromised"));
    }

    #[test]
    fn an_empty_filter_matches_nothing_and_is_invalid() {
        assert!(!matches(&[], "lifecycle.renewal.due"));
        assert!(!is_valid(&[], KNOWN));
    }

    #[test]
    fn unknown_entries_are_refused() {
        assert!(!is_valid(&filter(&["lifecycle.expiry.imminent"]), KNOWN));
        assert!(!is_valid(&filter(&["rumour.*"]), KNOWN));
        assert!(is_valid(
            &filter(&["lifecycle.*", "breach.scan.failed"]),
            KNOWN
        ));
        assert!(is_valid(&filter(&[WILDCARD_ALL]), KNOWN));
    }

    #[test]
    fn one_bad_entry_invalidates_the_whole_filter() {
        assert!(!is_valid(&filter(&["lifecycle.*", "nonsense"]), KNOWN));
    }

    #[test]
    fn a_family_is_the_segment_before_the_first_dot() {
        assert_eq!(family_of("breach.password.compromised"), "breach");
        assert_eq!(family_of("standalone"), "standalone");
    }

    #[test]
    fn a_bare_star_is_not_treated_as_a_family() {
        assert_eq!(wildcard_family(WILDCARD_ALL), Some(""));
        assert_eq!(wildcard_family("breach.*"), Some("breach"));
        assert_eq!(wildcard_family("breach.scan.failed"), None);
    }
}
