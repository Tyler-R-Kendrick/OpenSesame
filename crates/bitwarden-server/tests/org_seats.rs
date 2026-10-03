//! Seats that policies and revocations must not be undone by (ADR 0148 §9):
//! a role edit that raced a revocation, an invitation to an account another
//! organization binds, and two invitations claimed by one new account.
mod common;

use common::orgs::{account, add_member, Api, Org};
use common::Harness;
use opensesame_storage::bitwarden::{member_status, member_type};
use serde_json::json;

async fn single_organization(owner: &Api, org: &Org) {
    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/policies/3", org.id),
            Some(json!({"policy": {"enabled": true, "data": null}})),
        )
        .await;
}

async fn status_of(owner: &Api, org: &Org, email: &str) -> Option<i64> {
    let listed = owner
        .ok("GET", &format!("/organizations/{}/users", org.id), None)
        .await;
    listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == email)
        .map(|m| m["status"].as_i64().unwrap())
}

#[tokio::test]
async fn a_role_edit_read_before_a_revocation_cannot_bring_the_member_back() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (org, _) = Org::create(&owner, "Acme").await;
    add_member(&owner, &org, "member@example.com", &member, json!([])).await;

    // The edit read the member confirmed; before it commits, a policy turns
    // them out.
    let members = harness.db.bitwarden_org_members(&org.id).await.unwrap();
    let mut stale = members
        .iter()
        .find(|m| m.email == "member@example.com")
        .unwrap()
        .clone();
    assert_eq!(stale.status, member_status::CONFIRMED);
    let mut revoked = stale.clone();
    revoked.status = member_status::REVOKED;
    harness.db.bitwarden_update_member(&revoked).await.unwrap();

    stale.member_type = member_type::MANAGER;
    harness
        .db
        .bitwarden_edit_member_enforced(&stale)
        .await
        .unwrap()
        .unwrap();

    let after = harness.db.bitwarden_org_members(&org.id).await.unwrap();
    let after = after
        .iter()
        .find(|m| m.email == "member@example.com")
        .unwrap();
    assert_eq!(after.status, member_status::REVOKED, "still turned out");
    assert_eq!(after.member_type, member_type::MANAGER, "the edit landed");
}

#[tokio::test]
async fn an_account_bound_by_another_organization_is_not_invited_into_a_second_seat() {
    let harness = Harness::start().await;
    let (_, first) = account(&harness, "first@example.com").await;
    let (_, second) = account(&harness, "second@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (bound, _) = Org::create(&first, "Bound").await;
    let (other, _) = Org::create(&second, "Other").await;
    add_member(&first, &bound, "member@example.com", &member, json!([])).await;
    single_organization(&first, &bound).await;

    second
        .ok(
            "POST",
            &format!("/organizations/{}/users/invite", other.id),
            Some(json!({"emails": ["member@example.com"], "type": 2, "collections": []})),
        )
        .await;
    assert_eq!(status_of(&second, &other, "member@example.com").await, None);
    assert_eq!(
        status_of(&first, &bound, "member@example.com").await,
        Some(member_status::CONFIRMED),
        "their seat in the organization that binds them is untouched"
    );
    // The invitation that was refused cannot be confirmed either.
    assert!(member_id_opt(&second, &other).await.is_none());
}

async fn member_id_opt(owner: &Api, org: &Org) -> Option<String> {
    let listed = owner
        .ok("GET", &format!("/organizations/{}/users", org.id), None)
        .await;
    listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == "member@example.com")
        .map(|m| m["id"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn one_new_account_claims_one_of_two_invitations_under_single_organization() {
    let harness = Harness::start().await;
    let (_, first) = account(&harness, "first@example.com").await;
    let (_, second) = account(&harness, "second@example.com").await;
    let (one, _) = Org::create(&first, "One").await;
    let (two, _) = Org::create(&second, "Two").await;
    single_organization(&first, &one).await;
    single_organization(&second, &two).await;
    for (owner, org) in [(&first, &one), (&second, &two)] {
        owner
            .ok(
                "POST",
                &format!("/organizations/{}/users/invite", org.id),
                Some(json!({"emails": ["new@example.com"], "type": 2, "collections": []})),
            )
            .await;
    }

    // The account does not exist yet, so both wait. Registering claims what
    // it can: the first seat, and not the second.
    account(&harness, "new@example.com").await;
    let mine = status_of(&first, &one, "new@example.com").await.unwrap();
    let theirs = status_of(&second, &two, "new@example.com").await.unwrap();
    let mut seen = [mine, theirs];
    seen.sort_unstable();
    assert_eq!(seen, [member_status::INVITED, member_status::ACCEPTED]);
}
