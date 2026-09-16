//! COL-PORTAL — the install URL, and the scopes it must never ask for.

mod support;

use opensesame_collab_adapter::{install_invitation, ApplicationId, Refusal, Verb};
use support::scenario::APPLICATION_ID;
use url::Url;

fn params(url: &Url) -> std::collections::BTreeMap<String, String> {
    url.query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

/// A bot install, and nothing that mints a user token.
///
/// `identify` and `guilds` would return a token for the installing *person*, and
/// `response_type=code` plus a `redirect_uri` would be asking for a grant on
/// their behalf. `install_invitation` has no parameter for either, so this test
/// is checking that the absence is real on the wire, not just in the signature.
#[test]
fn the_install_url_asks_for_a_bot_and_never_for_a_person() {
    let invitation =
        install_invitation(&ApplicationId::new(APPLICATION_ID), &[Verb::ChannelRead]).unwrap();
    let url = invitation.url();
    let params = params(url);

    assert_eq!(url.host_str(), Some("discord.com"));
    assert_eq!(url.path(), "/oauth2/authorize");
    assert_eq!(
        params.get("client_id").map(String::as_str),
        Some(APPLICATION_ID)
    );
    assert_eq!(params.get("scope").map(String::as_str), Some("bot"));
    assert_eq!(invitation.scopes(), ["bot"]);

    for forbidden in [
        "identify",
        "email",
        "guilds",
        "guilds.join",
        "messages.read",
    ] {
        assert!(
            !params["scope"].split(' ').any(|scope| scope == forbidden),
            "{forbidden} mints a user token"
        );
    }
    assert_eq!(
        params.get("response_type"),
        None,
        "a bot install needs no code"
    );
    assert_eq!(params.get("redirect_uri"), None);
}

/// `integration_type=0` pins the guild install context.
///
/// Discord's user-install context attaches the application to the installing
/// person and follows them across servers. Stating the guild context explicitly
/// means a URL pasted into a chat cannot quietly become a user install.
#[test]
fn the_install_url_pins_the_guild_context() {
    let invitation =
        install_invitation(&ApplicationId::new(APPLICATION_ID), &[Verb::ChannelPost]).unwrap();
    assert_eq!(
        params(invitation.url())
            .get("integration_type")
            .map(String::as_str),
        Some("0")
    );
}

/// The bitfield is exactly the requested verbs, and it grows only when a verb
/// needs it.
#[test]
fn the_bitfield_is_least_privilege() {
    let read = install_invitation(&ApplicationId::new(APPLICATION_ID), &[Verb::ChannelRead])
        .unwrap()
        .permissions();
    assert_eq!(read, Verb::ChannelRead.permissions());
    assert_eq!(
        read.names(),
        vec!["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"],
        "an operator screen can show exactly this"
    );

    let everything = install_invitation(&ApplicationId::new(APPLICATION_ID), Verb::ALL).unwrap();
    assert_eq!(everything.permissions(), Verb::widest());
    assert!(
        !everything.permissions().is_elevated(),
        "even the widest install asks for nothing elevated"
    );
    assert!(
        !everything
            .requested_permission_names()
            .contains(&"ADMINISTRATOR"),
        "the durable, pasted-into-chat artifact is the last place to leak an admin invite"
    );
}

/// `applications.commands` is added only when a verb needs it — and it is an
/// application scope, not a person's.
#[test]
fn the_command_scope_is_requested_only_when_a_verb_needs_it() {
    let without =
        install_invitation(&ApplicationId::new(APPLICATION_ID), &[Verb::ChannelRead]).unwrap();
    assert_eq!(without.scopes(), ["bot"]);

    let with =
        install_invitation(&ApplicationId::new(APPLICATION_ID), &[Verb::CommandUse]).unwrap();
    assert_eq!(with.scopes(), ["bot", "applications.commands"]);
    assert_eq!(
        params(with.url()).get("scope").map(String::as_str),
        Some("bot applications.commands")
    );
}

/// An install asking for no permissions is a mistake, not a minimal request.
#[test]
fn an_empty_invitation_is_refused() {
    assert_eq!(
        install_invitation(&ApplicationId::new(APPLICATION_ID), &[]).unwrap_err(),
        Refusal::NoVerbs
    );
}
