#![no_main]

//! Fuzz the certificate-inventory filter's statement builder.
//!
//! The invariant under test is the one that matters at the boundary: whatever
//! arbitrary bytes arrive as `GET /api/v1/certmgr/certificates` query
//! parameters, the generated SQL is assembled only from compile-time literals.
//! Every caller value must travel as a bind, the placeholder count must equal
//! the bind count, and the statement text must be identical to the one a
//! neutral filter of the same shape produces — which is exactly what makes
//! SQL injection through this path impossible.

use libfuzzer_sys::fuzz_target;
use opensesame_storage::{CertificateFilter, MAX_FILTER_PATTERN_LEN};

/// Split arbitrary bytes into up to eight NUL-separated filter fields.
fn field(parts: &[&str], index: usize) -> Option<String> {
    parts
        .get(index)
        .filter(|part| !part.is_empty())
        .map(|part| (*part).to_owned())
}

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    let parts: Vec<&str> = text.split('\0').collect();
    let filter = CertificateFilter {
        status: field(&parts, 0),
        common_name_contains: field(&parts, 1),
        san_contains: field(&parts, 2),
        profile_id: field(&parts, 3),
        application_id: field(&parts, 4),
        expiring_before: field(&parts, 5),
        metadata_key: field(&parts, 6),
        metadata_value: field(&parts, 7),
        limit: data
            .first()
            .map(|byte| i64::from(*byte) * 1_000 - 50_000),
    };

    let query = filter.to_query();

    // The statement is a function of which predicates are active, never of what
    // the caller put in them: a neutral filter of the same shape must produce
    // byte-identical SQL.
    let neutral = CertificateFilter {
        status: filter.status.as_ref().map(|_| "S".to_owned()),
        common_name_contains: filter.common_name_contains.as_ref().map(|_| "S".to_owned()),
        san_contains: filter.san_contains.as_ref().map(|_| "S".to_owned()),
        profile_id: filter.profile_id.as_ref().map(|_| "S".to_owned()),
        application_id: filter.application_id.as_ref().map(|_| "S".to_owned()),
        expiring_before: filter.expiring_before.as_ref().map(|_| "S".to_owned()),
        metadata_key: filter.metadata_key.as_ref().map(|_| "S".to_owned()),
        metadata_value: filter.metadata_value.as_ref().map(|_| "S".to_owned()),
        limit: filter.limit,
    }
    .to_query();
    assert_eq!(query.sql, neutral.sql);

    // One placeholder for the organization, one per bind, one for the limit.
    let expected_placeholders = 1 + query.text_binds.len() + usize::from(query.limit.is_some());
    assert_eq!(query.sql.matches('?').count(), expected_placeholders);

    // No caller value appears inline in the statement.
    for bound in &query.text_binds {
        let inline = bound.trim_matches('%');
        if inline.len() > 8 {
            assert!(!query.sql.contains(inline));
        }
    }

    // Patterns are clamped at a character boundary and the limit is clamped to
    // a sane page, so no input can make the query unbounded or too complex.
    // Escaping can at most double a clamped needle, plus the two wildcards.
    for bound in &query.text_binds {
        assert!(bound.chars().count() <= 2 * MAX_FILTER_PATTERN_LEN + 2);
    }
    if let Some(limit) = query.limit {
        assert!((0..=1_000).contains(&limit));
    }
});
