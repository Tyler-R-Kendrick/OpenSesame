use super::*;
use crate::session_claims::parse_principal;
use opensesame_connection_broker::config_access::{role_policy, set_role_ceiling};

use super::{fixture, ALICE};

#[tokio::test]
async fn control_honors_the_role_evidence_fence() {
    let f = fixture().await;
    f.state
        .db
        .create_observation_run(&seed("run:1", ALICE, &f.org, "awaiting_human"))
        .await
        .unwrap();
    let before = f
        .state
        .db
        .get_observation_run(&f.org, "run:1")
        .await
        .unwrap()
        .unwrap();

    let principal = parse_principal(ALICE).expect("alice principal");
    let auth_time = Utc::now().timestamp() - 120;
    f.browser.verified_webauthn_at(&f.state, auth_time).await;
    let policy = role_policy(f.state.db.pool(), &f.state.connection_organization, &principal)
        .await
        .expect("role row")
        .expect("membership");
    set_role_ceiling(
        f.state.db.pool(),
        &f.state.connection_organization,
        &principal,
        None,
        policy.revision,
        Utc::now().timestamp(),
    )
    .await
    .expect("role cleared");

    let (status, _) = f.browser.control(&f, "run:1", "take").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let after = f
        .state
        .db
        .get_observation_run(&f.org, "run:1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.control_state, before.control_state);
}
