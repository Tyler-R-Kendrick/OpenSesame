//! COL-REGISTER — the ownership ledger and the scope boundary.

mod support;

use opensesame_collab_adapter::{
    AdapterRegistry, ApplicationId, ChannelId, CredentialKind, GuildId, ObservedRole, Permissions,
    Platform, Refusal, Registration, RoleId, TargetSpec, DISCORD_API_BASE,
};
use support::scenario::APPLICATION_ID;

const OTHER_GUILD: &str = "700000000000000099";

fn registration(channels: &[&str]) -> Registration {
    Registration::register(TargetSpec {
        platform: Platform::Discord,
        guild: GuildId::new(support::GUILD_ID),
        application: ApplicationId::new(APPLICATION_ID),
        channels: channels.iter().map(|id| ChannelId::new(*id)).collect(),
        credential_kind: CredentialKind::BotToken,
        base_url: None,
    })
    .expect("a bot credential")
}

fn role(id: &str, name: &str) -> ObservedRole {
    ObservedRole {
        id: RoleId::new(id),
        name: name.to_owned(),
        permissions: Permissions::NONE,
        position: 1,
        integration_managed: false,
    }
}

/// The default base URL is versioned. An unversioned Discord path is a moving
/// target.
#[test]
fn the_default_base_url_is_pinned_to_v10() {
    assert_eq!(registration(&[]).base_url(), DISCORD_API_BASE);
    assert!(DISCORD_API_BASE.ends_with("/api/v10"));
}

/// Ownership needs both halves: the ledger entry and the name prefix.
///
/// Either one alone is a way to delete somebody else's role — a name-only rule
/// adopts anything a person happened to call `opensesame/…`, and an id-only rule
/// keeps deleting a role after a person renamed it and took it over.
#[test]
fn ownership_requires_the_ledger_and_the_prefix() {
    let mut registration = registration(&[]);
    let ours = role("720000000000000001", "opensesame/auth-7");
    let renamed = role("720000000000000002", "Trusted contributors");
    let impostor = role("720000000000000003", "opensesame/hand-made");

    registration
        .record_owned_role(ours.id.clone(), "auth-7")
        .unwrap();
    registration
        .record_owned_role(renamed.id.clone(), "auth-8")
        .unwrap();

    assert!(registration.owns(&ours));
    assert!(!registration.owns(&renamed), "in the ledger, wrong name");
    assert!(
        !registration.owns(&impostor),
        "right name, not in the ledger"
    );

    assert_eq!(
        registration.assert_owns(&impostor).unwrap_err(),
        Refusal::RoleNotOwned {
            role: impostor.id.clone()
        }
    );
}

/// A role id cannot be claimed by two authorities.
///
/// Otherwise one authority's reconcile would delete another's role — and both
/// would be inside the ownership rule, so nothing would stop it.
#[test]
fn a_role_cannot_belong_to_two_authorities() {
    let mut registration = registration(&[]);
    let id = RoleId::new("720000000000000001");
    registration
        .record_owned_role(id.clone(), "auth-7")
        .unwrap();

    assert!(
        registration.record_owned_role(id.clone(), "auth-7").is_ok(),
        "recording the same pair twice is idempotent"
    );
    assert!(matches!(
        registration.record_owned_role(id.clone(), "auth-8"),
        Err(Refusal::AlreadyRegistered { .. })
    ));

    registration.forget_owned_role(&id);
    assert!(registration.owned_roles().is_empty());
}

/// Only the channels an operator offered are reachable.
#[test]
fn scope_is_exactly_what_the_operator_typed() {
    let registration = registration(&[support::CHANNEL_ID]);
    assert!(registration
        .assert_channel_in_scope(&ChannelId::new(support::CHANNEL_ID))
        .is_ok());
    assert_eq!(
        registration
            .assert_channel_in_scope(&ChannelId::new(support::OTHER_CHANNEL_ID))
            .unwrap_err(),
        Refusal::ChannelOutOfScope {
            channel: ChannelId::new(support::OTHER_CHANNEL_ID),
            guild: GuildId::new(support::GUILD_ID),
        }
    );
}

/// A guild is registered once.
///
/// Re-registering would silently replace the ownership ledger, and an adapter
/// with an empty ledger owns nothing — so a reconcile would stop cleaning up
/// while an apply would happily create a second role.
#[test]
fn a_guild_is_registered_once_and_looked_up_by_id() {
    let mut registry = AdapterRegistry::new();
    assert!(registry.is_empty());

    registry.register(registration(&[])).unwrap();
    assert_eq!(registry.len(), 1);
    assert!(matches!(
        registry.register(registration(&[])),
        Err(Refusal::AlreadyRegistered { .. })
    ));

    assert!(registry.target(&GuildId::new(support::GUILD_ID)).is_ok());
    assert_eq!(
        registry.target(&GuildId::new(OTHER_GUILD)).unwrap_err(),
        Refusal::GuildNotRegistered {
            guild: GuildId::new(OTHER_GUILD)
        }
    );
}

/// The registration is persistable and carries no credential.
///
/// The bot token lives with the transport, so a registration can be stored,
/// logged, or diffed without carrying a secret.
#[test]
fn a_registration_serializes_without_a_credential() {
    let mut registration = registration(&[support::CHANNEL_ID]);
    registration
        .record_owned_role(RoleId::new("720000000000000001"), "auth-7")
        .unwrap();

    let json = serde_json::to_string(&registration).unwrap();
    for forbidden in ["token", "secret", "authorization", "bot "] {
        assert!(
            !json.to_lowercase().contains(forbidden),
            "{forbidden} appears in {json}"
        );
    }
    assert_eq!(
        serde_json::from_str::<Registration>(&json).unwrap(),
        registration,
        "the ledger survives a round trip, or a restart would forget what it owns"
    );
}
