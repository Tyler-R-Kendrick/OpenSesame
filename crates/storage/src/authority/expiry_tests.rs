//! Which authority sidecars one lifecycle pass reads (ADR 0120 §5, ADR 0074 §1).

use chrono::Duration;

use super::*;
use crate::authority::tests::{entry, issue, seed_grant, seed_realm};
use crate::authority::AuthorityIssue;

async fn sidecar(
    db: &Db,
    organization_id: &str,
    domain_id: &str,
    grant_id: &str,
    expires_at: DateTime<ChronoUtc>,
) {
    seed_grant(db, organization_id, grant_id).await;
    let issued = db
        .issue_authority(
            &AuthorityIssue {
                not_before: expires_at - Duration::hours(1),
                expires_at,
                ..issue(grant_id, organization_id, domain_id)
            },
            &[entry("resource:A", "read")],
        )
        .await
        .expect("issue");
    assert!(issued, "{grant_id} was not issued");
}

#[tokio::test]
async fn a_pass_reads_live_grants_soonest_first_and_lapsed_ones_newest_first() {
    let db = Db::connect_memory().await.expect("db");
    let (organization, domain) = seed_realm(&db, "org:one").await;
    let now = ChronoUtc::now();
    for (grant_id, minutes) in [
        ("oldest-lapsed", -23 * 60),
        ("lapsed", -60),
        ("just-lapsed", -1),
        ("at-the-deadline", 0),
        ("soonest", 10),
        ("later", 50),
        ("latest", 120),
        ("withdrawn", 5),
    ] {
        sidecar(
            &db,
            &organization,
            &domain,
            grant_id,
            now + Duration::minutes(minutes),
        )
        .await;
    }
    sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = 'withdrawn'")
        .bind(now.to_rfc3339())
        .execute(db.pool())
        .await
        .expect("revoke");
    let (elsewhere, elsewhere_domain) = seed_realm(&db, "org:two").await;
    let in_five = now + Duration::minutes(5);
    sidecar(&db, &elsewhere, &elsewhere_domain, "elsewhere", in_five).await;

    let read = db
        .authority_grants_expiring(&organization, now, 2)
        .await
        .expect("read");
    let grants: Vec<&str> = read.iter().map(|row| row.grant_id.as_str()).collect();
    assert_eq!(
        grants,
        ["soonest", "later", "at-the-deadline", "just-lapsed"]
    );
}
