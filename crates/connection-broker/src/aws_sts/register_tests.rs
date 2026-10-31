//! Which deadlines one lifecycle pass reads from the mint register (ADR 0217).

use chrono::Duration;
use opensesame_storage::Db;

use super::*;

async fn register(pool: &SqlitePool, organization_id: &str, grant_id: &str, at: DateTime<Utc>) {
    record_mint(
        pool,
        &MintDeadline {
            grant_id: grant_id.into(),
            connection_id: "connection:aws".into(),
            organization_id: organization_id.into(),
            expires_at: at,
        },
        at - Duration::minutes(15),
    )
    .await
    .expect("register a mint");
}

#[tokio::test]
async fn a_pass_reads_live_mints_soonest_first_and_lapsed_ones_newest_first() {
    let db = Db::connect_memory().await.expect("db");
    let pool = db.pool();
    let now = Utc::now();
    for (grant_id, minutes) in [
        ("outside-grace", -25 * 60),
        ("oldest-lapsed", -23 * 60),
        ("lapsed", -60),
        ("just-lapsed", -1),
        ("soonest", 10),
        ("later", 50),
        ("latest", 120),
    ] {
        register(pool, "org:1", grant_id, now + Duration::minutes(minutes)).await;
    }
    register(pool, "org:2", "elsewhere", now + Duration::minutes(5)).await;

    let read = mints_to_scan(pool, "org:1", now, now - Duration::hours(24), 2)
        .await
        .expect("read");
    let grants: Vec<&str> = read.iter().map(|row| row.grant_id.as_str()).collect();
    assert_eq!(grants, ["soonest", "later", "just-lapsed", "lapsed"]);
}
