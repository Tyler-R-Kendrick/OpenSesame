//! The SLIP-0039 wordlist: 1024 words, 10 bits each, in the order the standard
//! fixes. It is `spec/conformance/slip39/wordlist.txt`, embedded from that one
//! file (ADR 0139); the TypeScript module embeds the same bytes and a drift
//! test on each side fails if they ever differ.

use std::sync::OnceLock;

const WORDLIST: &str = include_str!("../../../../spec/conformance/slip39/wordlist.txt");

/// The words, in index order.
pub fn words() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| WORDLIST.lines().filter(|line| !line.is_empty()).collect())
}

/// The 10-bit index of `word`, if it is one of the 1024, ignoring ASCII case.
///
/// The list is sorted, so this is a binary search; a test pins that. The word
/// is compared in place, so no lower-cased copy of a share's text is made.
#[must_use]
pub fn index_of(word: &str) -> Option<u16> {
    let lowered = word.bytes().map(|b| b.to_ascii_lowercase());
    let index = words()
        .binary_search_by(|candidate| candidate.bytes().cmp(lowered.clone()))
        .ok()?;
    u16::try_from(index).ok()
}

#[cfg(test)]
mod tests {
    use super::{index_of, words};

    #[test]
    fn is_the_standards_1024_sorted_words() {
        let list = words();
        assert_eq!(list.len(), 1024);
        assert!(list.windows(2).all(|pair| pair[0] < pair[1]));
        // The first four letters identify a word.
        let prefixes: std::collections::BTreeSet<&str> =
            list.iter().map(|w| &w[..4.min(w.len())]).collect();
        assert_eq!(prefixes.len(), 1024);
        assert_eq!(list[0], "academic");
        assert_eq!(list[1023], "zero");
    }

    #[test]
    fn looks_words_up_by_index() {
        assert_eq!(index_of("academic"), Some(0));
        assert_eq!(index_of("zero"), Some(1023));
        assert_eq!(index_of("bitcoin"), None);
        assert_eq!(index_of("ACADEMIC"), Some(0));
        assert_eq!(index_of("Zero"), Some(1023));
        assert_eq!(index_of("academi"), None);
        assert_eq!(index_of(""), None);
    }
}
