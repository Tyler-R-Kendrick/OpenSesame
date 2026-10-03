//! Who may be a member under organization policies (ADR 0148 §9), the cases
//! a review found open: a role change, an owner or admin bound elsewhere, an
//! organization arriving enabled, and two-step login removed. The decisions
//! are made in the store, in the transaction that changes the membership.
mod common;

use chrono::Utc;
use common::orgs::{account, add_member, member_id, Api, Org};
use common::vaultwarden::fixture;
use common::Harness;
use opensesame_authenticator_core::{parse_otpauth, totp_code};
use opensesame_bitwarden_server::import::{self, vaultwarden, WriteOptions};
use opensesame_storage::bitwarden::{member_status, member_type, BitwardenPolicy};
use serde_json::{json, Value};

async fn set(owner: &Api, org: &Org, kind: i64, enabled: bool) {
    owner
        .ok(
            "PUT",
            &format!("/organizations/{}/policies/{kind}", org.id),
            Some(json!({"policy": {"enabled": enabled, "data": null}})),
        )
        .await;
}

/// The member's status and role in the organization, as its owner lists them.
async fn standing(owner: &Api, org: &Org, email: &str) -> (i64, i64) {
    let listed = owner
        .ok("GET", &format!("/organizations/{}/users", org.id), None)
        .await;
    let member = listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == email)
        .unwrap();
    (
        member["status"].as_i64().unwrap(),
        member["type"].as_i64().unwrap(),
    )
}

/// Invite `email` into `org` with `role` and try to confirm it.
async fn invite_and_confirm(
    owner: &Api,
    org: &Org,
    email: &str,
    member: &Api,
    role: i64,
) -> (u16, Value) {
    owner
        .ok(
            "POST",
            &format!("/organizations/{}/users/invite", org.id),
            Some(json!({"emails": [email], "type": role, "collections": []})),
        )
        .await;
    let id = member_id(owner, org, email).await;
    let key = org.wrap_for(owner, &member.user_id().await).await;
    owner
        .post(
            &format!("/organizations/{}/users/{id}/confirm", org.id),
            json!({"key": key}),
        )
        .await
}

#[tokio::test]
async fn an_admin_demoted_is_held_to_the_policies_they_were_exempt_from() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (_, admin) = account(&harness, "admin@example.com").await;
    let (org, _) = Org::create(&owner, "Acme").await;
    assert_eq!(
        invite_and_confirm(&owner, &org, "admin@example.com", &admin, 1)
            .await
            .0,
        200
    );

    // The policy requires what the admin has not: they are exempt, and stay.
    set(&owner, &org, 0, true).await;
    assert_eq!(
        standing(&owner, &org, "admin@example.com").await,
        (member_status::CONFIRMED, member_type::ADMIN)
    );

    // Becoming an ordinary member would put them under it: refused, and the
    // role is unchanged.
    let id = member_id(&owner, &org, "admin@example.com").await;
    let demote = json!({"type": 2, "collections": []});
    let path = format!("/organizations/{}/users/{id}", org.id);
    assert_eq!(owner.put(&path, demote.clone()).await.0, 400);
    assert_eq!(
        standing(&owner, &org, "admin@example.com").await,
        (member_status::CONFIRMED, member_type::ADMIN)
    );

    // With the policy off, the same change goes through.
    set(&owner, &org, 0, false).await;
    assert_eq!(owner.put(&path, demote).await.0, 200);
    assert_eq!(
        standing(&owner, &org, "admin@example.com").await,
        (member_status::CONFIRMED, member_type::USER)
    );
}

#[tokio::test]
async fn an_owner_is_still_held_to_a_single_organization_policy_binding_them_elsewhere() {
    let harness = Harness::start().await;
    let (_, first) = account(&harness, "first@example.com").await;
    let (_, second) = account(&harness, "second@example.com").await;
    let (_, member) = account(&harness, "member@example.com").await;
    let (bound, _) = Org::create(&first, "Bound").await;
    let (other, _) = Org::create(&second, "Other").await;
    assert_eq!(
        invite_and_confirm(&first, &bound, "member@example.com", &member, 2)
            .await
            .0,
        200
    );
    set(&first, &bound, 3, true).await;

    // As an admin or owner of another organization they would hold two seats,
    // which the policy that binds them in the first forbids: the invitation
    // is not taken up, and the seat they hold is untouched.
    for role in [member_type::ADMIN, member_type::OWNER] {
        second
            .ok(
                "POST",
                &format!("/organizations/{}/users/invite", other.id),
                Some(json!({"emails": ["member@example.com"], "type": role, "collections": []})),
            )
            .await;
        let listed = second
            .ok("GET", &format!("/organizations/{}/users", other.id), None)
            .await;
        assert!(
            listed["data"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["email"] != "member@example.com"),
            "role {role}: no second seat"
        );
        assert_eq!(
            standing(&first, &bound, "member@example.com").await,
            (member_status::CONFIRMED, member_type::USER)
        );
    }
}

#[tokio::test]
async fn removing_the_last_two_step_provider_leaves_the_organizations_that_require_one() {
    let harness = Harness::start().await;
    let (_, owner) = account(&harness, "owner@example.com").await;
    let (person, member) = account(&harness, "member@example.com").await;
    let (org, _) = Org::create(&owner, "Acme").await;

    // The member turns the authenticator on, then joins.
    let proof = json!({"masterPasswordHash": person.password_hash()});
    let issued = member.post("/two-factor/get-authenticator", proof).await.1;
    let key = issued["key"].as_str().unwrap().to_owned();
    let uri = parse_otpauth(&format!("otpauth://totp/t?secret={key}")).unwrap();
    let now = u64::try_from(Utc::now().timestamp()).unwrap();
    let code = totp_code(&uri, now).unwrap();
    let enabled = member
        .put(
            "/two-factor/authenticator",
            json!({"key": key, "token": code,
                   "userVerificationToken": issued["userVerificationToken"]}),
        )
        .await;
    assert_eq!(enabled.0, 200, "{}", enabled.1);
    add_member(&owner, &org, "member@example.com", &member, json!([])).await;
    set(&owner, &org, 0, true).await;
    assert_eq!(
        standing(&owner, &org, "member@example.com").await.0,
        member_status::CONFIRMED,
        "they have what the policy asks"
    );

    // Turning it off takes them out of the organization in the same step.
    let off = member
        .put(
            "/two-factor/disable",
            json!({"type": 0, "key": key, "masterPasswordHash": person.password_hash()}),
        )
        .await;
    assert_eq!(off.0, 200, "{}", off.1);
    assert_eq!(
        standing(&owner, &org, "member@example.com").await.0,
        member_status::REVOKED
    );
    assert!(
        member.ok("GET", "/sync", None).await["profile"]["organizations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn an_organization_arriving_with_policies_on_revokes_the_members_they_exclude() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite3");
    fixture(&path).await;
    let mut source = vaultwarden::read(&path).await.unwrap();
    let target = Harness::start().await;

    // The owner arrives as an ordinary member under a two-step policy they
    // cannot meet here: their authenticator did not come across.
    let org = &mut source.organizations[0].arrival;
    for member in &mut org.members {
        if member.user_id.is_some() {
            member.member_type = member_type::USER;
        }
    }
    org.policies.push(BitwardenPolicy {
        id: uuid::Uuid::new_v4().to_string(),
        org_id: org.org.id.clone(),
        policy_type: 0,
        enabled: true,
        data: None,
        revision_at: Utc::now(),
    });
    let org_id = org.org.id.clone();
    import::write(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();
    let shared = import::write_shared(&target.db, &source, WriteOptions::default())
        .await
        .unwrap();

    assert_eq!(shared.organizations[0].revoked, 1);
    assert!(
        shared.organizations[0].ownerless,
        "its only owner arrived revoked"
    );
    let members = target.db.bitwarden_org_members(&org_id).await.unwrap();
    assert!(members
        .iter()
        .filter(|m| m.user_id.is_some())
        .all(|m| m.status == member_status::REVOKED));
}

#[tokio::test]
async fn creating_an_organization_and_enabling_single_organization_never_leave_two_seats() {
    // A database file, so the pool holds several connections and only the
    // store's write lock stands between the two requests.
    let dir = tempfile::tempdir().unwrap();
    let harness = Harness::start_in_file(&dir.path().join("race.sqlite3")).await;
    for round in 0..4 {
        let (_, owner) = account(&harness, &format!("owner{round}@example.com")).await;
        let (_, member) = account(&harness, &format!("member{round}@example.com")).await;
        let (org, _) = Org::create(&owner, "Held").await;
        add_member(
            &owner,
            &org,
            &format!("member{round}@example.com"),
            &member,
            json!([]),
        )
        .await;
        let create = member.post(
            "/organizations",
            json!({"name": "Mine", "billingEmail": "b@example.com", "key": "4.eA=="}),
        );
        let policy_path = format!("/organizations/{}/policies/3", org.id);
        let enable = owner.put(
            &policy_path,
            json!({"policy": {"enabled": true, "data": null}}),
        );
        let (created, enabled) = tokio::join!(create, enable);
        assert_eq!(enabled.0, 200, "round {round}: {}", enabled.1);
        let (status, _) = standing(&owner, &org, &format!("member{round}@example.com")).await;
        // Either the policy came first and the second seat was refused, or
        // the seat came first and the policy turned the member out of this
        // one. Never both seats, with the policy on.
        if created.0 == 200 {
            assert_eq!(status, member_status::REVOKED, "round {round}");
        } else {
            assert_eq!(created.0, 400, "round {round}: {}", created.1);
            assert_eq!(status, member_status::CONFIRMED, "round {round}");
        }
    }
}
