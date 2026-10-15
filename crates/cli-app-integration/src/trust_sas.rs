//! Short authentication string for root-trust fingerprints (D7-2 d).

/// Four hyphen-separated groups of four hex digits from the SPKI fingerprint.
#[must_use]
pub fn sas_from_fingerprint(fingerprint: &str) -> Option<String> {
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    Some(format!(
        "{}-{}-{}-{}",
        &fingerprint[0..4],
        &fingerprint[4..8],
        &fingerprint[8..12],
        &fingerprint[12..16],
    ))
}
