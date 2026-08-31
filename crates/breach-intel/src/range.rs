//! Parsing a Pwned Passwords range response.
//!
//! The response is plain text, one `SUFFIX:COUNT` per line, for every hash
//! sharing the requested prefix. We ask for padding, which mixes in decoy
//! entries with a count of zero so an observer cannot infer from the response
//! size whether the bucket was popular. A zero count therefore means "padding,
//! or absent" — the two are indistinguishable to us, and both mean "not
//! breached", which is exactly the property padding is meant to give.
//!
//! Parsing is total: a malformed line is skipped rather than failing the
//! lookup. A source that changes its formatting slightly should degrade to
//! fewer matches, not to an exception that stops the whole scan.

use crate::digest::PwnedDigest;

/// Base of the range endpoint; the five character prefix is appended.
pub const RANGE_URL_BASE: &str = "https://api.pwnedpasswords.com/range/";

/// Request header that asks the service to pad the response with decoys.
pub const PADDING_HEADER: &str = "Add-Padding";
/// Value for [`PADDING_HEADER`].
pub const PADDING_VALUE: &str = "true";

/// The URL to fetch for a digest. Only the prefix is interpolated, so this
/// function is the one place a full digest could have leaked into a URL and
/// visibly does not.
#[must_use]
pub fn range_url(digest: &PwnedDigest) -> String {
    format!("{RANGE_URL_BASE}{}", digest.prefix())
}

/// How many times the digest's password appears in the corpus.
///
/// Zero means not found — including when the only matching line was padding.
#[must_use]
pub fn occurrences(body: &str, digest: &PwnedDigest) -> u64 {
    occurrences_for_suffix(body, digest.suffix())
}

/// The same lookup keyed on a bare suffix, for callers that already split one.
#[must_use]
pub fn occurrences_for_suffix(body: &str, suffix: &str) -> u64 {
    body.lines()
        .filter_map(parse_line)
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(suffix))
        .map_or(0, |(_, count)| count)
}

/// One `SUFFIX:COUNT` line, or `None` when it is not one.
fn parse_line(line: &str) -> Option<(&str, u64)> {
    let (suffix, count) = line.trim().split_once(':')?;
    if suffix.is_empty() {
        return None;
    }
    // A count that will not parse is treated as zero rather than dropped: the
    // suffix still matched, and reporting "present, count unknown" would be a
    // claim the response did not support.
    Some((suffix, count.trim().parse().unwrap_or(0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A response shaped like the real one: uppercase suffixes, CRLF endings,
    /// and padding entries at zero.
    const BODY: &str = "\
003D68EB55068C33ACE09247EE4C639306B:3\r\n\
1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365\r\n\
011053FD0102E94D6AE2F8B83D76FAF94F6:0\r\n";

    fn digest(secret: &str) -> PwnedDigest {
        PwnedDigest::of_secret(secret)
    }

    #[test]
    fn the_url_carries_the_prefix_and_nothing_else() {
        let digest = digest("password");
        let url = range_url(&digest);
        assert_eq!(url, format!("{RANGE_URL_BASE}5BAA6"));
        assert!(
            !url.contains(digest.suffix()),
            "the suffix must never reach a URL",
        );
    }

    #[test]
    fn a_present_password_reports_its_occurrence_count() {
        // "password" is 5BAA6 / 1E4C9B93F3F0682250B6CF8331B7EE68FD8.
        assert_eq!(occurrences(BODY, &digest("password")), 9_659_365);
    }

    #[test]
    fn an_absent_password_reports_zero() {
        assert_eq!(occurrences(BODY, &digest("a-password-nobody-has-used")), 0);
    }

    #[test]
    fn a_padding_entry_is_indistinguishable_from_absence() {
        assert_eq!(
            occurrences_for_suffix(BODY, "011053FD0102E94D6AE2F8B83D76FAF94F6"),
            0,
        );
    }

    #[test]
    fn matching_tolerates_a_lowercase_response() {
        let lowered = BODY.to_ascii_lowercase();
        assert_eq!(occurrences(&lowered, &digest("password")), 9_659_365);
    }

    #[test]
    fn malformed_lines_are_skipped_rather_than_fatal() {
        let messy = format!("garbage\n\n:12\n{BODY}not-a-line");
        assert_eq!(occurrences(&messy, &digest("password")), 9_659_365);
    }

    #[test]
    fn an_unparseable_count_reports_zero_rather_than_guessing() {
        assert_eq!(occurrences_for_suffix("ABC:many", "ABC"), 0);
    }

    #[test]
    fn an_empty_body_reports_zero() {
        assert_eq!(occurrences("", &digest("password")), 0);
    }
}
