//! Live Discord — **opt-in only**, and `#[ignore]`d.
//!
//! Nothing in this file runs under `cargo test`, `pnpm verify`, or CI. It exists
//! because a fixture proves the adapter is self-consistent, not that Discord
//! agrees with it: only a real guild can catch a renamed field, a changed status
//! code, or a route Discord has since versioned away.
//!
//! Running it needs a throwaway guild you own, and it will create, assign, and
//! delete a role in it:
//!
//! ```bash
//! export OPENSESAME_DISCORD_LIVE=1
//! export OPENSESAME_DISCORD_BOT_TOKEN=...   # a bot token, from the Developer Portal
//! export OPENSESAME_DISCORD_GUILD_ID=...
//! export OPENSESAME_DISCORD_CHANNEL_ID=...
//! export OPENSESAME_DISCORD_SUBJECT_ID=...  # a member of that guild
//! cargo +1.88.0 test -p opensesame-collab-adapter --test live -- --ignored
//! ```
//!
//! The token must be a **bot** token. There is no user-token path in this crate,
//! and a personal account's token would be self-botting — against Discord's
//! terms, and a good way to lose the account.
//!
//! The test cleans up after itself with a full reconcile sweep. It is written as
//! one test rather than several so a partial failure cannot leave a role behind
//! in a guild that a later run would then adopt.

mod support;

use std::env;

use chrono::{Duration, Utc};
use opensesame_collab_adapter::{
    plan_apply, plan_reconcile, ApplicationId, AuthorityProjection, ChannelId, CollabClient,
    CredentialKind, GuildId, Platform, Registration, RoleId, Sweep, TargetSpec, UserId, Verb,
};
use support::transport::HyperTransport;

/// The authority handle the live run projects. Distinct from the fixture's so a
/// leftover role is identifiable as having come from a live run.
const LIVE_AUTHORITY_ID: &str = "live-smoke";

fn required(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} must be set for the live test"))
}

/// The whole lifecycle against a real guild: install-scoped bot, apply, verify,
/// revoke, verify.
#[tokio::test]
#[ignore = "requires a live Discord guild and bot token (set OPENSESAME_DISCORD_LIVE=1 plus OPENSESAME_DISCORD_BOT_TOKEN/GUILD_ID/CHANNEL_ID/SUBJECT_ID)"]
async fn live_apply_then_revoke_leaves_the_guild_as_it_was() {
    assert_eq!(
        env::var("OPENSESAME_DISCORD_LIVE").ok().as_deref(),
        Some("1"),
        "set OPENSESAME_DISCORD_LIVE=1 to acknowledge this mutates a real guild"
    );

    let guild = GuildId::new(required("OPENSESAME_DISCORD_GUILD_ID"));
    let channel = ChannelId::new(required("OPENSESAME_DISCORD_CHANNEL_ID"));
    let subject = UserId::new(required("OPENSESAME_DISCORD_SUBJECT_ID"));

    let mut registration = Registration::register(TargetSpec {
        platform: Platform::Discord,
        guild: guild.clone(),
        application: ApplicationId::new(
            env::var("OPENSESAME_DISCORD_APPLICATION_ID").unwrap_or_default(),
        ),
        channels: vec![channel.clone()],
        credential_kind: CredentialKind::BotToken,
        // No base_url override: the live run goes to https://discord.com/api/v10.
        base_url: None,
    })
    .expect("a bot credential against Discord's own base url");

    let token = opensesame_collab_adapter::BotToken::from_credential(
        CredentialKind::BotToken,
        required("OPENSESAME_DISCORD_BOT_TOKEN"),
    )
    .expect("a bot token");
    let client = CollabClient::new(
        HyperTransport::new(),
        opensesame_collab_adapter::NoBackoff,
        token,
    );

    let projection = AuthorityProjection {
        authority_id: LIVE_AUTHORITY_ID.to_owned(),
        subject: subject.clone(),
        guild: guild.clone(),
        channels: vec![channel],
        verbs: vec![Verb::ChannelRead, Verb::ChannelPost],
        expires_at: Utc::now() + Duration::minutes(5),
        revoked: false,
    };

    let observed = client
        .observe(&registration, &subject)
        .await
        .expect("Discord answers the four reads");
    let plan = plan_apply(&registration, &projection, &observed, Utc::now())
        .expect("a live projection is planned");
    let outcome = client
        .execute(&registration, &plan)
        .await
        .expect("Discord accepts the plan");

    let created = outcome
        .created_role
        .clone()
        .unwrap_or_else(|| RoleId::new(String::new()));
    if !created.as_str().is_empty() {
        registration
            .record_owned_role(created.clone(), LIVE_AUTHORITY_ID)
            .expect("recording the role we just made");
    }

    let after_apply = client.observe(&registration, &subject).await.unwrap();
    assert!(
        after_apply.member.roles.iter().any(|role| role == &created),
        "the subject should hold the role Discord just created"
    );

    // Clean up, and prove the reconciler removes only what it made.
    let sweep = plan_reconcile(&registration, &after_apply, &[], Sweep::UnassignAndDelete)
        .expect("a revocation is planned");
    client
        .execute(&registration, &sweep)
        .await
        .expect("Discord accepts the revocation");

    let after_revoke = client.observe(&registration, &subject).await.unwrap();
    assert!(
        !after_revoke.roles.iter().any(|role| role.id == created),
        "the role should be gone from the guild"
    );
    assert_eq!(
        after_revoke
            .member
            .roles
            .iter()
            .filter(|role| *role != &created)
            .count(),
        after_apply
            .member
            .roles
            .iter()
            .filter(|role| *role != &created)
            .count(),
        "every other role the member held is still there"
    );
}
