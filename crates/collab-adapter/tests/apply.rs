//! COL-APPLY against the loopback fixture: the protocol walk, in order, with the
//! bodies Discord actually expects.

mod support;

use opensesame_collab_adapter::{
    permissions, plan_apply, Permissions, RoleTarget, Step, Verb, OWNED_ROLE_PREFIX,
};
use serde_json::json;
use support::scenario::{now, owned_role_name, projection, Scenario};
use support::{GuildState, CHANNEL_ID, MODERATOR_ROLE_ID, SUBJECT_ID};

/// The whole happy path, over HTTP, asserting the *sequence* — not the set.
///
/// Create the role, bound it to the channel, and only then put it on the member.
/// If the membership step moved ahead of the overwrite, the subject would briefly
/// hold a role whose channel scope had not been written, which on a guild where
/// `@everyone` can view channels is a real over-grant that leaves no trace.
#[tokio::test]
async fn apply_creates_scopes_then_assigns_in_that_order() {
    let scene = Scenario::start(GuildState::new()).await;
    let projection = projection(&[Verb::ChannelRead, Verb::ChannelPost]);
    let observed = scene.observe().await;

    let plan = plan_apply(&scene.registration, &projection, &observed, now())
        .expect("a live projection over in-scope channels is planned");

    assert_eq!(
        plan.labels(),
        vec!["create_role", "set_channel_overwrite", "add_member_role"],
        "the role must be bounded before anybody holds it"
    );
    assert!(matches!(plan.steps[0], Step::CreateRole { .. }));
    assert!(
        matches!(&plan.steps[1], Step::SetChannelOverwrite { role, .. } if role == &RoleTarget::PendingCreate),
        "the overwrite names the role the plan is about to create"
    );

    let outcome = scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .expect("the fixture accepts every step");

    assert_eq!(
        scene.fixture.mutations(),
        vec![
            format!("POST /api/v10/guilds/{}/roles", support::GUILD_ID),
            format!(
                "PUT /api/v10/channels/{CHANNEL_ID}/permissions/{}",
                outcome.created_role.as_ref().unwrap()
            ),
            format!(
                "PUT /api/v10/guilds/{}/members/{SUBJECT_ID}/roles/{}",
                support::GUILD_ID,
                outcome.created_role.as_ref().unwrap()
            ),
        ]
    );

    let state = scene.fixture.state.lock().unwrap();
    assert!(state.role_names().contains(&owned_role_name()));
    assert!(state
        .member_role_ids(SUBJECT_ID)
        .contains(&outcome.created_role.unwrap().to_string()));
}

/// The bodies, checked against Discord's own shape.
///
/// `permissions` and `allow`/`deny` are decimal **strings**: Discord moved them
/// off JSON numbers when the bitfield outgrew IEEE-754, and a client that sends
/// integers is rejected. The overwrite's `type: 0` says the target is a role —
/// `1` would attach the authority to the person directly, leaving nothing named
/// in the role list to revoke.
#[tokio::test]
async fn wire_bodies_match_the_protocol() {
    let scene = Scenario::start(GuildState::new()).await;
    let projection = projection(&[Verb::ChannelRead]);
    let observed = scene.observe().await;
    let plan = plan_apply(&scene.registration, &projection, &observed, now()).unwrap();
    scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .unwrap();

    let expected =
        Permissions::from_bits(permissions::VIEW_CHANNEL | permissions::READ_MESSAGE_HISTORY)
            .to_string();
    let hits = scene.fixture.hits();

    let create = hits.iter().find(|hit| hit.method == "POST").unwrap();
    assert_eq!(
        create.body,
        Some(json!({
            "name": owned_role_name(),
            "permissions": expected,
            "hoist": false,
            "mentionable": false,
        })),
        "a managed authority role is plumbing: not hoisted, not mentionable"
    );

    let overwrite = hits
        .iter()
        .find(|hit| hit.path.contains("/permissions/"))
        .unwrap();
    assert_eq!(
        overwrite.body,
        Some(json!({ "type": 0, "allow": expected, "deny": "0" })),
        "type 0 is a role overwrite, and this adapter denies nothing it did not grant"
    );
}

/// Every mutation carries `Authorization: Bot …` and an audit reason naming the
/// authority; reads carry the token and no reason.
///
/// The audit reason is the link from a guild's own audit log back to an
/// OpenSesame authority — the server's operator can answer "why does this person
/// have this role" without asking us.
#[tokio::test]
async fn every_request_is_a_bot_and_every_mutation_is_explained() {
    let scene = Scenario::start(GuildState::new()).await;
    let projection = projection(&[Verb::ChannelPost]);
    let observed = scene.observe().await;
    let plan = plan_apply(&scene.registration, &projection, &observed, now()).unwrap();
    scene
        .client
        .execute(&scene.registration, &plan)
        .await
        .unwrap();

    for hit in scene.fixture.hits() {
        let authorization = hit.authorization.as_deref().unwrap_or_default();
        assert!(
            authorization.starts_with("Bot "),
            "{} {} authenticated as {authorization}",
            hit.method,
            hit.path
        );
        assert!(
            !authorization.starts_with("Bearer"),
            "a Bearer header is a user token, and this adapter has no path to one"
        );
        if hit.method == "GET" {
            assert_eq!(hit.audit_reason, None, "a GET needs no audit reason");
        } else {
            assert_eq!(
                hit.audit_reason.as_deref(),
                Some("OpenSesame authority auth-7: apply collaboration authority"),
                "{} {} is unexplained in the guild's audit log",
                hit.method,
                hit.path
            );
        }
    }
}

/// Re-applying converges: the second run finds its own role and does nothing.
///
/// The role is found by name, so a second apply must not create
/// `opensesame/auth-7` twice — a guild caps at 250 roles, and a projection that
/// leaks one per reconciliation cycle would exhaust that.
#[tokio::test]
async fn re_applying_is_a_noop() {
    let scene = Scenario::start(GuildState::new()).await;
    let projection = projection(&[Verb::ChannelRead]);

    let first = plan_apply(
        &scene.registration,
        &projection,
        &scene.observe().await,
        now(),
    )
    .unwrap();
    let outcome = scene
        .client
        .execute(&scene.registration, &first)
        .await
        .unwrap();

    let mut registration = scene.registration.clone();
    registration
        .record_owned_role(outcome.created_role.clone().unwrap(), "auth-7")
        .unwrap();

    let second = plan_apply(&registration, &projection, &scene.observe().await, now())
        .expect("the second pass finds the role it made");
    assert!(
        second.is_noop(),
        "expected convergence, got {:?}",
        second.labels()
    );

    let names = scene.fixture.state.lock().unwrap().role_names();
    assert_eq!(
        names
            .iter()
            .filter(|name| *name == &owned_role_name())
            .count(),
        1
    );
}

/// A widened projection corrects the existing role in place.
///
/// `PATCH` rather than delete-and-recreate: a recreate changes the role id, and
/// every channel overwrite in the guild keyed by the old id would quietly stop
/// applying.
#[tokio::test]
async fn a_changed_projection_patches_the_role_it_owns() {
    let mut state = GuildState::new();
    let role_id = "720000000000000055";
    state.push_role(
        role_id,
        &owned_role_name(),
        &Permissions::from_bits(permissions::VIEW_CHANNEL).to_string(),
        1,
    );
    state.give_member_role(SUBJECT_ID, role_id);
    let scene = Scenario::start(state).await;

    let mut registration = scene.registration.clone();
    registration
        .record_owned_role(opensesame_collab_adapter::RoleId::new(role_id), "auth-7")
        .unwrap();

    let plan = plan_apply(
        &registration,
        &projection(&[Verb::ChannelRead, Verb::ChannelPost]),
        &scene.observe().await,
        now(),
    )
    .unwrap();

    assert_eq!(
        plan.labels(),
        vec!["update_role_permissions", "set_channel_overwrite"],
        "the member already holds the role, so only the bits and the scope move"
    );
    scene.client.execute(&registration, &plan).await.unwrap();

    let state = scene.fixture.state.lock().unwrap();
    let role = state
        .roles
        .iter()
        .find(|role| role["id"] == role_id)
        .unwrap();
    assert_eq!(
        role["permissions"].as_str().unwrap(),
        Permissions::from_bits(
            permissions::VIEW_CHANNEL
                | permissions::READ_MESSAGE_HISTORY
                | permissions::SEND_MESSAGES
                | permissions::EMBED_LINKS
        )
        .to_string()
    );
}

/// The member's other roles are named in the plan as deliberately untouched.
#[tokio::test]
async fn the_plan_states_what_it_left_alone() {
    let scene = Scenario::start(GuildState::new()).await;
    let plan = plan_apply(
        &scene.registration,
        &projection(&[Verb::ChannelRead]),
        &scene.observe().await,
        now(),
    )
    .unwrap();

    let untouched: Vec<String> = plan.untouched.iter().map(ToString::to_string).collect();
    assert!(untouched.contains(&MODERATOR_ROLE_ID.to_owned()));
    assert!(untouched.contains(&support::BOOSTER_ROLE_ID.to_owned()));
    assert!(
        !untouched
            .iter()
            .any(|role| role.starts_with(OWNED_ROLE_PREFIX)),
        "the prefix is a name, never an id"
    );
}
