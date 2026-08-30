//! Property coverage for the certificate inventory filter.
//!
//! Property: for any generated [`CertificateFilter`], `list_certificates`
//! returns exactly the seeded rows that satisfy every active predicate — no
//! more (a leak) and no fewer (a silent drop). The oracle is an in-memory
//! filter applied to the same seed set, so the SQL and the intent are compared
//! against each other rather than against a hand-written expectation.

mod support;

use opensesame_storage::{CertificateFilter, Db, StoredManagedCertificate};
use proptest::prelude::*;
use support::{seed_org, ORG_ONE};

const STATUSES: [&str; 3] = ["active", "revoked", "expired"];
const NAMES: [&str; 4] = [
    "alpha.example",
    "beta.internal",
    "gamma.example",
    "delta.test",
];

/// Deterministic seed set: eight certificates spanning every axis the filter
/// can narrow on.
async fn seed(db: &Db) -> Vec<StoredManagedCertificate> {
    let (authority, _, profile_id, application_id) = seed_org(db, ORG_ONE, "one").await;
    let mut seeded = Vec::new();
    for index in 0..8usize {
        let suffix = format!("seed{index}");
        db.insert_certificate_issuance_request(&support::issuance_request(
            ORG_ONE,
            &authority,
            &format!("request:{suffix}"),
        ))
        .await
        .expect("request");
        let mut record = support::certificate(
            ORG_ONE,
            &authority,
            &format!("request:{suffix}"),
            &format!("cert:{suffix}"),
        );
        record.status = STATUSES[index % STATUSES.len()].into();
        record.common_name = NAMES[index % NAMES.len()].into();
        record.san_json = format!(
            r#"{{"dns_names":["{}"],"ip_addrs":[]}}"#,
            record.common_name
        );
        if index % 2 == 0 {
            record.profile_id = Some(profile_id.clone());
        }
        if index % 3 == 0 {
            record.application_id = Some(application_id.clone());
        }
        record.expires_at = format!("2027-0{}-01T00:00:00+00:00", (index % 9) + 1);
        record.metadata_json = if index % 4 == 0 {
            r#"{"team":"platform"}"#.into()
        } else {
            r#"{"team":"edge"}"#.into()
        };
        db.insert_managed_certificate(&record)
            .await
            .expect("certificate");
        seeded.push(record);
    }
    seeded
}

/// The oracle: apply the filter's intent directly to the seeded rows.
fn expected(seeded: &[StoredManagedCertificate], filter: &CertificateFilter) -> Vec<String> {
    let mut matched: Vec<&StoredManagedCertificate> = seeded
        .iter()
        .filter(|record| {
            filter
                .status
                .as_ref()
                .is_none_or(|status| &record.status == status)
                && filter
                    .common_name_contains
                    .as_ref()
                    .is_none_or(|needle| record.common_name.contains(needle.as_str()))
                && filter
                    .san_contains
                    .as_ref()
                    .is_none_or(|needle| record.san_json.contains(needle.as_str()))
                && filter
                    .profile_id
                    .as_ref()
                    .is_none_or(|id| record.profile_id.as_ref() == Some(id))
                && filter
                    .application_id
                    .as_ref()
                    .is_none_or(|id| record.application_id.as_ref() == Some(id))
                && filter
                    .expiring_before
                    .as_ref()
                    .is_none_or(|cutoff| record.expires_at.as_str() <= cutoff.as_str())
                && filter.metadata_key.as_ref().is_none_or(|key| {
                    filter.metadata_value.as_ref().is_none_or(|value| {
                        record
                            .metadata_json
                            .contains(&format!(r#""{key}":"{value}""#))
                    })
                })
        })
        .collect();
    matched
        .sort_by(|left, right| (&left.expires_at, &left.id).cmp(&(&right.expires_at, &right.id)));
    let mut ids: Vec<String> = matched
        .into_iter()
        .map(|record| record.id.clone())
        .collect();
    if let Some(limit) = filter.limit {
        ids.truncate(usize::try_from(limit.max(0)).unwrap_or(0));
    }
    ids
}

fn filter_strategy() -> impl Strategy<Value = CertificateFilter> {
    (
        proptest::option::of(proptest::sample::select(STATUSES.as_slice())),
        proptest::option::of(proptest::sample::select(
            ["alpha", "example", "internal", "zzz"].as_slice(),
        )),
        proptest::option::of(proptest::sample::select(
            ["alpha.example", "gamma", "nowhere"].as_slice(),
        )),
        proptest::option::of(Just("profile:one".to_string())),
        proptest::option::of(Just("app:one".to_string())),
        proptest::option::of(proptest::sample::select(
            [
                "2027-01-01T00:00:00+00:00",
                "2027-05-01T00:00:00+00:00",
                "2027-09-01T00:00:00+00:00",
            ]
            .as_slice(),
        )),
        proptest::option::of(proptest::sample::select(["platform", "edge"].as_slice())),
        proptest::option::of(1i64..12),
    )
        .prop_map(
            |(status, cn, san, profile_id, application_id, expiring, team, limit)| {
                CertificateFilter {
                    status: status.map(str::to_string),
                    common_name_contains: cn.map(str::to_string),
                    san_contains: san.map(str::to_string),
                    profile_id,
                    application_id,
                    expiring_before: expiring.map(str::to_string),
                    metadata_key: team.map(|_| "team".to_string()),
                    metadata_value: team.map(str::to_string),
                    limit,
                }
            },
        )
}

#[test]
fn property_list_certificates_returns_exactly_the_matching_rows() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let (db, seeded) = runtime.block_on(async {
        let db = Db::connect_memory().await.expect("migrate");
        let seeded = seed(&db).await;
        (db, seeded)
    });

    proptest!(|(filter in filter_strategy())| {
        let observed: Vec<String> = runtime
            .block_on(db.list_certificates(ORG_ONE, &filter))
            .expect("list")
            .into_iter()
            .map(|record| record.id)
            .collect();
        prop_assert_eq!(observed, expected(&seeded, &filter));
    });
}

#[test]
fn property_filters_never_interpolate_caller_values() {
    proptest!(|(needle in ".{0,64}")| {
        let generated = filled_filter(&needle).to_query();
        let neutral = filled_filter("PLACEHOLDER").to_query();
        // The statement text is a function of which predicates are active, not
        // of what the caller put in them: two filters with identical shape and
        // different values produce byte-identical SQL.
        prop_assert_eq!(&generated.sql, &neutral.sql);
        prop_assert_eq!(generated.text_binds.len(), 8);
        prop_assert_eq!(generated.sql.matches('?').count(), 9);
    });
}

fn filled_filter(value: &str) -> CertificateFilter {
    CertificateFilter {
        status: Some(value.to_string()),
        common_name_contains: Some(value.to_string()),
        san_contains: Some(value.to_string()),
        profile_id: Some(value.to_string()),
        application_id: Some(value.to_string()),
        expiring_before: Some(value.to_string()),
        metadata_key: Some(value.to_string()),
        metadata_value: Some(value.to_string()),
        limit: None,
    }
}
