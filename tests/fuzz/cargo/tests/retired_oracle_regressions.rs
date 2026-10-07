//! Deterministic replay of four captured fuzz-oracle failures.
//! These invoke the real helpers/builders; they are not coverage-guided fuzzing.

use arbitrary::{Arbitrary, Unstructured};
use opensesame_domain::{DevDeliveryPolicy, DomainError, Grant, GrantId};
use opensesame_env_spec::{parse_schema_json, resolve_for_delivery, schema_summary};
use opensesame_fuzz::oracles::assert_attenuation_did_not_widen;
use opensesame_fuzz::types::{ClaimReplayInput, GrantPairInput};
use opensesame_fuzz::{fuzz_claim_replay, fuzz_env_spec, fuzz_grant_attenuation};
use opensesame_grants::delegate;
use opensesame_storage::CertificateFilter;

const CERTMGR_FILTER_PARSE: &str = concat!(
    "020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202",
    "020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202",
    "020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202",
    "020202020202020202020202020202020202020202020202020202020202020202020202020202025c5c5c5c5c5c5c5c",
    "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c",
    "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c",
    "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c020202020202020202020202020202020202020202020202020202",
    "020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202",
    "02020202020202020202020202020202020202020202020202020202020202020202020202025c5c5c5c5c5c5c5c5c5c",
    "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c",
    "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c",
    "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c0202020202020202020202020202020202020202020202020202020202",
    "020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202",
    "02022500000025",
);

const CLAIM_REPLAY: &str = concat!("802e744865",);

const ENV_SPEC: &str = concat!(
    "7b22736368656d615f70617468223a222e656e762e736368656d61222c22706172736572223a22656e762d7370656322",
    "2c226974656d73223a5b7b226b6579223a22534543524554222c2273656e736974697665223a747275652c2272657175",
    "69726564223a747275657d5d7d",
);

const GRANT_ATTENUATION: &str = concat!(
    "219b0000000000ca9a283b0101010d9b9b9b9b9b9b9b9b009b9b9bffffffffffffffff9b272101010101010100000000",
    "0000000001ffffffff01090101010206",
);

fn captured_bytes(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("fixture hex"), 16)
                .expect("fixture byte")
        })
        .collect()
}

#[test]
fn captured_long_equality_filter_keeps_exact_bind_and_neutral_sql() {
    let bytes = captured_bytes(CERTMGR_FILTER_PARSE);
    let text = String::from_utf8_lossy(&bytes);
    let fields: Vec<_> = text.split('\0').collect();
    assert_eq!(fields.len(), 4);
    assert!(fields[0].chars().count() > 514);
    let filter = CertificateFilter {
        status: Some(fields[0].to_owned()),
        profile_id: Some(fields[3].to_owned()),
        limit: bytes.first().map(|byte| i64::from(*byte) * 1_000 - 50_000),
        ..CertificateFilter::default()
    };
    assert!(fields[1].is_empty() && fields[2].is_empty());
    assert!(fields.iter().skip(4).all(|field| field.is_empty()));
    let query = filter.to_query();
    let neutral = CertificateFilter {
        status: Some("neutral".into()),
        profile_id: Some("neutral".into()),
        limit: filter.limit,
        ..CertificateFilter::default()
    }
    .to_query();
    assert_eq!(query.sql, neutral.sql);
    assert_eq!(query.text_binds, vec![fields[0], fields[3]]);
    assert_eq!(query.sql.matches('?').count(), 4);
    assert_eq!(query.limit, Some(0));
}

#[test]
fn captured_claim_and_fresh_expired_claimed_controls_replay_real_verifier() {
    let bytes = captured_bytes(CLAIM_REPLAY);
    let captured =
        ClaimReplayInput::arbitrary(&mut Unstructured::new(&bytes)).expect("captured claim input");
    fuzz_claim_replay(captured);
    for (expires_secs, start_claimed) in [(3600, false), (-3600, false), (3600, true)] {
        fuzz_claim_replay(ClaimReplayInput {
            token: "controlled-regression-claim".into(),
            expires_secs,
            now_secs: 0,
            start_claimed,
        });
    }
}

#[test]
fn captured_missing_sensitive_value_and_present_value_stay_omitted() {
    let bytes = captured_bytes(ENV_SPEC);
    fuzz_env_spec(&bytes);
    let original = parse_schema_json(std::str::from_utf8(&bytes).expect("captured JSON"))
        .expect("captured schema");
    assert_eq!(original.items.len(), 1);
    assert!(original.items[0].sensitive);
    assert_eq!(original.items[0].value, None);
    for value in [None, Some("CONTROLLED_SYNTHETIC_SECRET".to_owned())] {
        let mut doc = original.clone();
        doc.items[0].value = value.clone();
        let encoded = serde_json::to_vec(&doc).expect("schema JSON");
        fuzz_env_spec(&encoded);
        let summary = schema_summary(&doc);
        let item = &summary["items"][0];
        assert_eq!(item["key"], doc.items[0].key);
        assert_eq!(item["value_present"], value.is_some());
        assert!(item.get("value").is_none());
        assert!(!summary.to_string().contains("CONTROLLED_SYNTHETIC_SECRET"));
        let resolved = resolve_for_delivery(&doc, &DevDeliveryPolicy::agent_default(), true)
            .expect("agent policy");
        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].omitted);
        assert_eq!(resolved[0].env_value, None);
    }
}

fn grant_fixture() -> Grant {
    let bytes = captured_bytes(GRANT_ATTENUATION);
    let input =
        GrantPairInput::arbitrary(&mut Unstructured::new(&bytes)).expect("captured grant input");
    let mut parent = input.parent.into_grant();
    parent.constraints.audiences.clear();
    parent.constraints.maximum_delegation_depth = 2;
    parent.delegation_depth = 0;
    parent.revoked_at = None;
    parent.constraints.not_before = None;
    parent
}

#[test]
fn captured_grant_replays_the_actual_attenuation_helper() {
    let bytes = captured_bytes(GRANT_ATTENUATION);
    let input =
        GrantPairInput::arbitrary(&mut Unstructured::new(&bytes)).expect("captured grant input");
    fuzz_grant_attenuation(input);
}

#[test]
fn unrestricted_audience_narrows_but_restricted_parent_cannot_be_widened() {
    let parent = grant_fixture();
    let mut child = parent.clone();
    child.id = GrantId::new();
    child.constraints.audiences = vec!["https://controlled.example".into()];
    child.constraints.maximum_delegation_depth = 1;
    let narrowed = delegate(&parent, child).expect("unrestricted parent may narrow");
    assert_attenuation_did_not_widen(&parent, &narrowed);
    assert_eq!(
        narrowed.constraints.audiences,
        vec!["https://controlled.example"]
    );
    assert_eq!(narrowed.parent_grant_id, Some(parent.id));
    let mut restricted = parent.clone();
    restricted.constraints.audiences = narrowed.constraints.audiences.clone();
    let retained = delegate(&restricted, narrowed.clone()).expect("same audience retained");
    assert_attenuation_did_not_widen(&restricted, &retained);
    for audiences in [vec![], vec!["https://foreign.example".to_owned()]] {
        let mut widening = narrowed.clone();
        widening.constraints.audiences = audiences;
        let result = delegate(&restricted, widening);
        assert!(
            matches!(result, Err(DomainError::GrantAttenuation(reason)) if reason.contains("audiences"))
        );
    }
    assert_eq!(parent.constraints.audiences, Vec::<String>::new());
    assert_eq!(
        restricted.constraints.audiences,
        vec!["https://controlled.example"]
    );
}

#[test]
fn metadata_clamps_characters_without_like_escaping() {
    let value = "é_%\\".repeat(300);
    let expected: String = value
        .chars()
        .take(opensesame_storage::MAX_FILTER_PATTERN_LEN)
        .collect();
    let query = CertificateFilter {
        metadata_key: Some(value.clone()),
        metadata_value: Some(value),
        ..CertificateFilter::default()
    }
    .to_query();
    assert_eq!(query.text_binds, vec![expected.clone(), expected]);
    assert_eq!(query.sql.matches('?').count(), 3);
    assert!(!query.sql.contains(" LIKE "));
    assert!(!query.sql.contains("é"));
}
