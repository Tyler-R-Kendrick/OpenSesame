//! COL-RECONCILE — the destructive path, and the roles it must never touch.
//!
//! Every test here is really the same test from a different angle: a reconciler
//! walking into a real server must remove only what it created. The fixture
//! member deliberately holds a human role (`moderator`) and an
//! integration-managed one (`Server Booster`) alongside the adapter's own, and
//! the assertions are as much about what is still there afterwards as about what
//! went away.

mod support;

use opensesame_collab_adapter::{
    orphaned_owned_roles, permissions, plan_reconcile, Permissions, RoleId, Sweep, UserId,
};
use support::scenario::{owned_role_name, Scenario};
use support::{GuildState, BOOSTER_ROLE_ID, MODERATOR_ROLE_ID, SUBJECT_ID};

const OWNED_ROLE_ID: &str = "720000000000000055";
/// A role somebody created by hand inside our namespace. Not ours: it is not in
/// the ledger.
const IMPOSTOR_ROLE_ID: &str = "720000000000000077";

fn read_permissions() -> String {
    Permissions::from_bits(permissions::VIEW_CHANNEL | permissions::READ_MESSAGE_HISTORY)
        .to_string()
}

/// A guild where the member holds our role, a human role, a booster role, and a
/// hand-made role that copied our naming.
async fn crowded_guild() -> Scenario {
    let mut state = GuildState::new();
    state.push_role(OWNED_ROLE_ID, &owned_role_name(), &read_permissions(), 1);
    state.push_role(IMPOSTOR_ROLE_ID, "opensesame/hand-made", "0", 2);
    state.give_member_role(SUBJECT_ID, OWNED_ROLE_ID);
    state.give_member_role(SUBJECT_ID, IMPOSTOR_ROLE_ID);
    let scene = Scenario::start(state).await;
    let mut registration = scene.registration.clone();
    registration
        .record_owned_role(RoleId::new(OWNED_ROLE_ID), "auth-7")
        .unwrap();
    Scenario {
        registration,
        ..scene
    }
}

/// Revoking everything removes our role and nothing else — including the role
/// that merely *looks* like ours.
#[tokio::test]
async fn reconcile_removes_only_what_it_created() {
    let scene = crowded_guild().await;
    let observed = scene.observe().await;

    let plan = plan_reconcile(
        &scene.registration,
        &observed,
        &[],
        Sweep::UnassignAndDelete,
    )
    .expect("reconciling a registered guild is planned");

    assert_eq!(plan.labels(), vec!["remove_member_role", "delete_role"]);
    assert!(plan.is_destructive());

    let untouched: Vec<String> = plan.untouched.iter().map(ToString::to_string).collect();
    for survivor in [MODERATOR_ROLE_ID, BOOSTER_ROLE_ID, IMPOSTOR_ROLE_ID] {
        assert!(
            untouched.contains(&survivor.to_owned()),
            "{survivor} should have been left alone"
        );
    }

    scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .unwrap();

    let state = scene.fixture.state.lock().unwrap();
    assert!(
        !state.role_names().contains(&owned_role_name()),
        "our own role should be gone"
    );
    assert_eq!(
        state.member_role_ids(SUBJECT_ID),
        vec![
            MODERATOR_ROLE_ID.to_owned(),
            BOOSTER_ROLE_ID.to_owned(),
            IMPOSTOR_ROLE_ID.to_owned()
        ],
        "everything the adapter did not create is still on the member"
    );
}

/// A role in our namespace that we never recorded is not ours, no matter what it
/// is called.
///
/// This is the half of the ownership rule that protects a server from a stale or
/// empty ledger: with no ledger entry, the name alone proves nothing.
#[tokio::test]
async fn a_similarly_named_role_we_never_created_is_not_ours() {
    let scene = crowded_guild().await;
    let observed = scene.observe().await;
    let impostor = observed
        .role(&RoleId::new(IMPOSTOR_ROLE_ID))
        .expect("the fixture has it");

    assert!(!scene.registration.owns(impostor));
    assert!(
        impostor.name_claims_ownership(),
        "the name does claim ownership — which is why the name alone must not be enough"
    );
    assert!(scene.registration.assert_owns(impostor).is_err());
}

/// A role we did create, that a person has since renamed out of our namespace,
/// is theirs now.
///
/// The ledger still holds the id, so an id-only rule would delete it. They took
/// it over; a reconciler that overruled them would be the bug.
#[tokio::test]
async fn a_role_a_human_renamed_away_from_us_is_left_alone() {
    let mut state = GuildState::new();
    state.push_role(
        OWNED_ROLE_ID,
        "Trusted contributors",
        &read_permissions(),
        1,
    );
    state.give_member_role(SUBJECT_ID, OWNED_ROLE_ID);
    let scene = Scenario::start(state).await;
    let mut registration = scene.registration.clone();
    registration
        .record_owned_role(RoleId::new(OWNED_ROLE_ID), "auth-7")
        .unwrap();

    let observed = scene
        .client
        .observe(&registration, &UserId::new(SUBJECT_ID))
        .await
        .unwrap();
    let plan = plan_reconcile(&registration, &observed, &[], Sweep::UnassignAndDelete).unwrap();

    assert!(plan.is_noop(), "expected nothing, got {:?}", plan.labels());
    assert!(plan
        .untouched
        .iter()
        .any(|role| role.as_str() == OWNED_ROLE_ID));
}

/// The default sweep takes the membership away and leaves the empty role behind.
///
/// Removal order is the mirror of apply: membership first, so the authority is
/// revoked in effect after step one and the delete is only cleanup. A failed
/// second call cannot leave a member holding a role id that no longer resolves.
#[tokio::test]
async fn unassign_leaves_the_role_and_removes_the_membership_first() {
    let scene = crowded_guild().await;
    let observed = scene.observe().await;
    let plan = plan_reconcile(&scene.registration, &observed, &[], Sweep::Unassign).unwrap();

    assert_eq!(plan.labels(), vec!["remove_member_role"]);
    scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .unwrap();

    let state = scene.fixture.state.lock().unwrap();
    assert!(
        state.role_names().contains(&owned_role_name()),
        "the role survives an unassign sweep"
    );
    assert!(!state
        .member_role_ids(SUBJECT_ID)
        .contains(&OWNED_ROLE_ID.to_owned()));
}

/// A still-live authority keeps its role.
#[tokio::test]
async fn a_live_authority_survives_reconciliation() {
    let scene = crowded_guild().await;
    let observed = scene.observe().await;
    let plan = plan_reconcile(
        &scene.registration,
        &observed,
        &[owned_role_name()],
        Sweep::UnassignAndDelete,
    )
    .unwrap();

    assert!(plan.is_noop());
    assert!(!plan.is_destructive());
}

/// An owned role nobody holds is still findable, so an unassign sweep can be
/// cleaned up later.
#[tokio::test]
async fn orphaned_roles_are_reported_separately_from_memberships() {
    let scene = crowded_guild().await;
    let observed = scene.observe().await;

    let orphans = orphaned_owned_roles(&scene.registration, &observed, &[]);
    assert_eq!(
        orphans.iter().map(ToString::to_string).collect::<Vec<_>>(),
        vec![OWNED_ROLE_ID.to_owned()]
    );
    assert!(
        orphaned_owned_roles(&scene.registration, &observed, &[owned_role_name()]).is_empty(),
        "a live authority's role is not an orphan"
    );
}
