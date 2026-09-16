//! The refusals, and the structural facts behind them.
//!
//! The first three tests are the load-bearing ones: they assert that
//! `ADMINISTRATOR` is *unreachable* rather than merely rejected, and that a user
//! credential cannot become an `Authorization` header. If somebody later adds a
//! verb that grants `MANAGE_ROLES`, or relaxes `BotToken`'s constructor, these
//! fail — which is the whole reason they are phrased over the catalogue instead
//! of over one example.

mod support;

use chrono::Duration;
use opensesame_collab_adapter::{
    permissions, plan_apply, ApplicationId, BotToken, CredentialKind, GuildId, Permissions,
    Platform, Refusal, Registration, TargetSpec, Verb, ELEVATED,
};
use support::scenario::{now, owned_role_name, projection, Scenario, APPLICATION_ID};
use support::{GuildState, OTHER_CHANNEL_ID, SUBJECT_ID};

/// No verb, and no combination of verbs, can reach an elevated bit.
///
/// This is the "refuse admin roles" guarantee. It is not a check inside
/// `plan_apply` that a future caller could route around; the widest permission
/// set the type system can produce simply does not contain `ADMINISTRATOR`,
/// `MANAGE_ROLES`, `MANAGE_CHANNELS`, or any other bit that would let a holder
/// widen itself.
#[test]
fn the_verb_catalogue_cannot_express_an_elevated_permission() {
    let widest = Verb::widest();
    assert!(
        !widest.is_elevated(),
        "the union of every verb reaches {:?}",
        widest.elevated()
    );
    assert_eq!(widest.bits() & ELEVATED, 0);

    for verb in Verb::ALL {
        let permissions = verb.permissions();
        assert!(
            !permissions.is_elevated(),
            "{} grants {:?}",
            verb.as_action(),
            permissions.elevated()
        );
    }
}

/// `ADMINISTRATOR` is in the refused mask, together with every bit that lets its
/// holder rewrite the permission graph around it.
#[test]
fn the_elevated_mask_covers_escalation_by_the_long_route() {
    for (name, bit) in [
        ("ADMINISTRATOR", permissions::ADMINISTRATOR),
        ("MANAGE_ROLES", permissions::MANAGE_ROLES),
        ("MANAGE_CHANNELS", permissions::MANAGE_CHANNELS),
        ("MANAGE_GUILD", permissions::MANAGE_GUILD),
        ("MANAGE_WEBHOOKS", permissions::MANAGE_WEBHOOKS),
        ("BAN_MEMBERS", permissions::BAN_MEMBERS),
        ("KICK_MEMBERS", permissions::KICK_MEMBERS),
        ("MODERATE_MEMBERS", permissions::MODERATE_MEMBERS),
        ("MENTION_EVERYONE", permissions::MENTION_EVERYONE),
        ("VIEW_AUDIT_LOG", permissions::VIEW_AUDIT_LOG),
    ] {
        assert!(
            Permissions::from_bits(bit).is_elevated(),
            "{name} should be refused"
        );
        assert_eq!(Permissions::from_bits(bit).elevated(), vec![name]);
    }
}

/// A user credential cannot become a bot token, and a bot token cannot become a
/// `Bearer` header.
#[test]
fn no_user_credential_can_authenticate_this_adapter() {
    for kind in [
        CredentialKind::UserAccessToken,
        CredentialKind::UserRefreshToken,
        CredentialKind::UserPassword,
        CredentialKind::UserSessionToken,
    ] {
        assert_eq!(
            BotToken::from_credential(kind, "whatever").unwrap_err(),
            Refusal::UserCredential { kind: kind.label() }
        );
        assert!(kind.is_user());
    }

    let token = BotToken::from_credential(CredentialKind::BotToken, "secret-bot-token").unwrap();
    assert!(token.authorization_header().starts_with("Bot "));
    assert!(
        !format!("{token:?}").contains("secret-bot-token"),
        "Debug must redact: a transport that logs its request should not leak the token"
    );
}

/// Registering with a user credential is refused where a person can read it,
/// rather than at the first apply.
#[test]
fn registration_refuses_a_user_credential_and_a_plaintext_base_url() {
    let spec = |kind, base_url: Option<&str>| TargetSpec {
        platform: Platform::Discord,
        guild: GuildId::new(support::GUILD_ID),
        application: ApplicationId::new(APPLICATION_ID),
        channels: vec![],
        credential_kind: kind,
        base_url: base_url.map(str::to_owned),
    };

    assert_eq!(
        Registration::register(spec(CredentialKind::UserAccessToken, None)).unwrap_err(),
        Refusal::UserCredential {
            kind: "user oauth2 access token"
        }
    );
    assert_eq!(
        Registration::register(spec(
            CredentialKind::BotToken,
            Some("http://discord.example")
        ))
        .unwrap_err(),
        Refusal::BaseUrlInsecure {
            url: "http://discord.example".to_owned()
        },
        "plaintext is allowed only to a loopback fixture"
    );
    assert!(Registration::register(spec(
        CredentialKind::BotToken,
        Some("http://127.0.0.1:8080/api")
    ))
    .is_ok());
    assert!(Registration::register(spec(CredentialKind::BotToken, None)).is_ok());
}

/// An out-of-scope channel is refused before a request is formed.
#[tokio::test]
async fn a_channel_the_operator_never_offered_is_out_of_scope() {
    let scene = Scenario::start(GuildState::new()).await;
    let mut projection = projection(&[Verb::ChannelRead]);
    projection
        .channels
        .push(opensesame_collab_adapter::ChannelId::new(OTHER_CHANNEL_ID));

    let refusal = plan_apply(
        &scene.registration,
        &projection,
        &scene.observe().await,
        now(),
    )
    .unwrap_err();
    assert!(matches!(refusal, Refusal::ChannelOutOfScope { .. }));
    assert!(
        scene.fixture.mutations().is_empty(),
        "a refusal must not have changed the guild"
    );
}

/// An expired or revoked authority is refused by apply, not silently turned into
/// a removal — deciding what to delete is `plan_reconcile`'s job, asked for by
/// name.
#[tokio::test]
async fn a_dead_authority_is_not_an_apply() {
    let scene = Scenario::start(GuildState::new()).await;
    let observed = scene.observe().await;

    let mut expired = projection(&[Verb::ChannelRead]);
    expired.expires_at = now() - Duration::minutes(1);
    assert!(matches!(
        plan_apply(&scene.registration, &expired, &observed, now()).unwrap_err(),
        Refusal::AuthorityExpired { .. }
    ));

    let mut revoked = projection(&[Verb::ChannelRead]);
    revoked.revoked = true;
    assert_eq!(
        plan_apply(&scene.registration, &revoked, &observed, now()).unwrap_err(),
        Refusal::AuthorityRevoked
    );
    assert!(scene.fixture.mutations().is_empty());
}

/// A role at or above the bot's own position is refused with the position in the
/// message, instead of becoming an opaque `50013` from Discord.
#[tokio::test]
async fn a_role_above_the_bot_is_refused_with_the_reason() {
    let mut state = GuildState::new();
    let role_id = "720000000000000090";
    state.push_role(
        role_id,
        &owned_role_name(),
        "0",
        support::BOT_ROLE_POSITION + 1,
    );
    state.give_member_role(SUBJECT_ID, role_id);
    let scene = Scenario::start(state).await;

    let mut registration = scene.registration.clone();
    registration
        .record_owned_role(opensesame_collab_adapter::RoleId::new(role_id), "auth-7")
        .unwrap();

    let refusal = plan_apply(
        &registration,
        &projection(&[Verb::ChannelRead]),
        &scene
            .client
            .observe(
                &registration,
                &opensesame_collab_adapter::UserId::new(SUBJECT_ID),
            )
            .await
            .unwrap(),
        now(),
    )
    .unwrap_err();

    match refusal {
        Refusal::RoleAboveBot {
            position,
            bot_position,
            ..
        } => {
            assert_eq!(position, support::BOT_ROLE_POSITION + 1);
            assert_eq!(bot_position, support::BOT_ROLE_POSITION);
        }
        other => panic!("expected RoleAboveBot, got {other}"),
    }
}

/// An unknown action string is refused, never dropped.
///
/// Dropping it would report success for a projection narrower than the audit
/// trail claims — and would answer `guild.administrate` with silence.
#[test]
fn an_action_outside_the_catalogue_is_a_refusal_not_a_filter() {
    use opensesame_collab_adapter::AuthorityProjection;

    let refusal = AuthorityProjection::verbs_from_actions(&[
        "channel.read".to_owned(),
        "guild.administrate".to_owned(),
    ])
    .unwrap_err();
    assert_eq!(
        refusal,
        Refusal::UnknownVerb {
            action: "guild.administrate".to_owned()
        }
    );
    assert_eq!(
        AuthorityProjection::verbs_from_actions(&[]).unwrap_err(),
        Refusal::NoVerbs
    );
    assert_eq!(
        AuthorityProjection::verbs_from_actions(&[
            "channel.read".to_owned(),
            "channel.read".to_owned()
        ])
        .unwrap(),
        vec![Verb::ChannelRead],
        "duplicates collapse rather than doubling the request"
    );
}

/// The projection is metadata. No field can carry a value (ADR 0005), asserted
/// over the serialized form the way `crates/grants` does for `Grant`.
#[test]
fn a_projection_serializes_no_secret() {
    let json = serde_json::to_string(&projection(&[Verb::ChannelRead, Verb::CommandUse])).unwrap();
    for forbidden in [
        "token",
        "secret",
        "password",
        "bot ",
        "authorization",
        "access_token",
    ] {
        assert!(
            !json.to_lowercase().contains(forbidden),
            "{forbidden} appears in {json}"
        );
    }
    assert!(json.contains("channel.read"), "verbs serialize as actions");
}

/// The wire vocabulary and [`Verb::as_action`] cannot drift apart.
#[test]
fn every_verb_serializes_as_its_action_string() {
    for verb in Verb::ALL {
        let json = serde_json::to_string(verb).unwrap();
        assert_eq!(json, format!("\"{}\"", verb.as_action()));
        assert_eq!(Verb::parse(verb.as_action()), Some(*verb));
    }
    assert_eq!(Verb::parse("guild.administrate"), None);
}

/// Discord serializes a permission bitfield as a decimal string because it
/// outgrew IEEE-754. A client that parses it as a number corrupts anything above
/// `1 << 53`.
#[test]
fn permissions_round_trip_as_a_decimal_string() {
    let high = Permissions::from_bits(1 << 54 | permissions::VIEW_CHANNEL);
    let json = serde_json::to_string(&high).unwrap();
    assert_eq!(json, format!("\"{}\"", (1_u64 << 54) | (1 << 10)));
    assert_eq!(
        serde_json::from_str::<Permissions>(&json).unwrap(),
        high,
        "a high bit must survive the round trip exactly"
    );
    assert!(serde_json::from_str::<Permissions>("2048").is_err());
}
