//! Behavior (given/when/then) coverage for operator-visible Certificate
//! Manager storage behavior.
//!
//! Each scenario is named for the operator outcome it protects, so a failure
//! reads as a broken promise rather than as a broken query.

mod support;

use opensesame_storage::{
    ApprovalStepOutcome, CertificateFilter, Db, StoredApprovalDecision, StoredScepConfig,
};
use support::{
    approval_policy, approval_request, approval_step, seed_certificate, seed_org, NOW, ORG_ONE,
    ORG_TWO,
};

#[tokio::test]
async fn given_a_certificate_issued_under_a_profile_when_it_is_renewed_then_both_directions_link_and_metadata_survives(
) {
    // given
    let db = Db::connect_memory().await.expect("migrate");
    let (authority, _, profile_id, application_id) = seed_org(&db, ORG_ONE, "one").await;
    let predecessor = seed_certificate(&db, ORG_ONE, &authority, "alpha").await;
    db.set_certificate_metadata(ORG_ONE, &predecessor.id, r#"{"team":"platform"}"#)
        .await
        .expect("metadata");

    db.insert_certificate_issuance_request(&support::issuance_request(
        ORG_ONE,
        &authority,
        "request:renewal",
    ))
    .await
    .expect("request");
    let mut successor =
        support::certificate(ORG_ONE, &authority, "request:renewal", "cert:renewal");
    successor.profile_id = Some(profile_id);
    successor.application_id = Some(application_id);
    db.insert_managed_certificate(&successor)
        .await
        .expect("successor");

    // when
    db.insert_renewal_link(ORG_ONE, &predecessor.id, &successor.id)
        .await
        .expect("renewal link");

    // then
    assert_eq!(
        db.get_renewed_by(ORG_ONE, &predecessor.id)
            .await
            .expect("successor")
            .map(|found| found.id),
        Some(successor.id.clone())
    );
    assert_eq!(
        db.get_renewed_from(ORG_ONE, &successor.id)
            .await
            .expect("predecessor")
            .map(|found| found.id),
        Some(predecessor.id.clone())
    );
    assert_eq!(
        db.get_certificate_metadata(ORG_ONE, &predecessor.id)
            .await
            .expect("metadata")
            .as_deref(),
        Some(r#"{"team":"platform"}"#)
    );
}

#[tokio::test]
async fn given_a_two_step_approval_policy_when_the_first_step_is_satisfied_then_the_request_advances_but_is_not_approved(
) {
    // given
    let db = Db::connect_memory().await.expect("migrate");
    let (_, _, _, application_id) = seed_org(&db, ORG_ONE, "one").await;
    db.insert_approval_policy(&approval_policy(ORG_ONE, "approval:one", &application_id))
        .await
        .expect("policy");
    db.insert_approval_step(&approval_step(ORG_ONE, "step:0", "approval:one", 0, 2))
        .await
        .expect("step 0");
    db.insert_approval_step(&approval_step(ORG_ONE, "step:1", "approval:one", 1, 1))
        .await
        .expect("step 1");
    db.insert_approval_request(&approval_request(ORG_ONE, "request:one", "approval:one"))
        .await
        .expect("request");

    // when: the first of two required approvers decides
    db.insert_approval_decision(&decision("decision:0", "principal:ada", 0))
        .await
        .expect("first decision");
    assert_eq!(
        db.approval_step_outcome(ORG_ONE, "request:one")
            .await
            .expect("outcome"),
        ApprovalStepOutcome::Pending
    );
    assert_eq!(
        db.get_approval_request(ORG_ONE, "request:one")
            .await
            .expect("request")
            .expect("present")
            .current_step,
        0
    );

    // when: the second approver decides, satisfying the step
    db.insert_approval_decision(&decision("decision:1", "principal:grace", 0))
        .await
        .expect("second decision");
    assert_eq!(
        db.approval_step_outcome(ORG_ONE, "request:one")
            .await
            .expect("outcome"),
        ApprovalStepOutcome::StepSatisfied
    );
    db.advance_approval_step(ORG_ONE, "request:one", 0)
        .await
        .expect("advance");

    // then: the request sits on step two and is still open
    let request = db
        .get_approval_request(ORG_ONE, "request:one")
        .await
        .expect("request")
        .expect("present");
    assert_eq!(request.current_step, 1);
    assert_eq!(request.status, "open");
    assert_eq!(
        db.list_decisions_for_request(ORG_ONE, "request:one")
            .await
            .expect("decisions")
            .len(),
        2
    );
}

#[tokio::test]
async fn given_a_scep_challenge_already_consumed_when_a_second_enrollment_presents_it_then_it_is_rejected(
) {
    // given
    let db = Db::connect_memory().await.expect("migrate");
    let (_, _, profile_id, _) = seed_org(&db, ORG_ONE, "one").await;
    db.insert_scep_config(&StoredScepConfig {
        id: "scep:one".into(),
        organization_id: ORG_ONE.into(),
        profile_id,
        challenge_mode: "dynamic".into(),
        sealed_static_secret: None,
        ra_signs_with_ca: true,
        include_ca_cert: true,
        allow_cert_renewal: false,
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    })
    .await
    .expect("scep config");
    db.mint_scep_challenge(
        ORG_ONE,
        "scep:one",
        "sha256:challenge",
        "2099-01-01T00:00:00+00:00",
    )
    .await
    .expect("mint");
    db.consume_scep_challenge(ORG_ONE, "scep:one", "sha256:challenge")
        .await
        .expect("first enrollment");

    // when / then
    assert!(db
        .consume_scep_challenge(ORG_ONE, "scep:one", "sha256:challenge")
        .await
        .is_err());
}

#[tokio::test]
async fn given_two_organizations_each_with_a_certificate_when_one_lists_then_the_other_is_never_returned(
) {
    // given
    let db = Db::connect_memory().await.expect("migrate");
    let (authority_one, ..) = seed_org(&db, ORG_ONE, "one").await;
    let (authority_two, ..) = seed_org(&db, ORG_TWO, "two").await;
    let mine = seed_certificate(&db, ORG_ONE, &authority_one, "alpha").await;
    let theirs = seed_certificate(&db, ORG_TWO, &authority_two, "beta").await;

    // when
    let listed = db
        .list_certificates(ORG_ONE, &CertificateFilter::default())
        .await
        .expect("list");

    // then
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, mine.id);
    assert!(db
        .get_certificate(ORG_ONE, &theirs.id)
        .await
        .expect("cross-tenant read")
        .is_none());
    assert!(db
        .list_certificates(
            ORG_ONE,
            &CertificateFilter {
                common_name_contains: Some("alpha".into()),
                ..CertificateFilter::default()
            }
        )
        .await
        .expect("filtered list")
        .iter()
        .all(|record| record.organization_id == ORG_ONE));
}

fn decision(id: &str, approver: &str, step_seq: i64) -> StoredApprovalDecision {
    StoredApprovalDecision {
        id: id.into(),
        organization_id: ORG_ONE.into(),
        request_id: "request:one".into(),
        step_seq,
        approver: approver.into(),
        decision: "approve".into(),
        comment: None,
        decided_at: NOW.into(),
        version: 1,
        created_at: NOW.into(),
        updated_at: NOW.into(),
    }
}
