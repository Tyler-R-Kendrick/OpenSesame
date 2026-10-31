//! A full pass of lapsed mints whose expiry was already published must not
//! crowd a live mint out of collection (ADR 0217, ADR 0074).

use chrono::{DateTime, Duration, Utc};
use opensesame_connection_broker::aws_sts::register::{record_mint, MintDeadline};
use opensesame_lifecycle::{ExpiryStage, SubjectKind, Track};

use super::MINT_SCAN_LIMIT;
use crate::app_state::{test_demo_state, AppState};
use crate::lifecycle::scanner::scan_organization;

async fn mint(state: &AppState, grant_id: &str, expires_at: DateTime<Utc>) {
    record_mint(
        state.db.pool(),
        &MintDeadline {
            grant_id: grant_id.into(),
            connection_id: "connection:aws".into(),
            organization_id: state.connection_organization.to_string(),
            expires_at,
        },
        expires_at - Duration::minutes(15),
    )
    .await
    .expect("register a mint");
}

/// How far up the alert ladder the scanner has published a mint.
async fn alert_stage(state: &AppState, grant_id: &str) -> Option<String> {
    state
        .db
        .get_lifecycle_watermarks(
            &state.connection_organization.to_string(),
            SubjectKind::ConnectionCredential.as_str(),
            &format!("aws-sts-mint:{grant_id}"),
        )
        .await
        .expect("watermarks")
        .into_iter()
        .find(|row| row.track == Track::Alert.as_str())
        .map(|row| row.stage)
}

#[tokio::test]
async fn published_expiries_never_crowd_a_live_mint_out_of_the_pass() {
    let state = test_demo_state().await;
    let organization = state.connection_organization;
    let now = Utc::now();
    for index in 0..MINT_SCAN_LIMIT {
        let lapsed = now - Duration::hours(23) + Duration::seconds(index);
        mint(&state, &format!("lapsed-{index:03}"), lapsed).await;
    }
    mint(&state, "live", now + Duration::minutes(30)).await;

    scan_organization(&state, &organization, now)
        .await
        .expect("first pass");
    assert_eq!(
        alert_stage(&state, "lapsed-000").await.as_deref(),
        Some(ExpiryStage::Expired.as_str())
    );
    assert_eq!(
        alert_stage(&state, "live").await.as_deref(),
        Some(ExpiryStage::Urgent.as_str()),
        "a live mint got no advance notice"
    );

    // The live mint lapses while every older one, already published, is
    // still inside the grace window.
    scan_organization(&state, &organization, now + Duration::minutes(31))
        .await
        .expect("second pass");
    assert_eq!(
        alert_stage(&state, "live").await.as_deref(),
        Some(ExpiryStage::Expired.as_str()),
        "a lapsed mint's expiry was not published on the pass after it"
    );
}
