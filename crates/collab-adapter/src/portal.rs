//! COL-PORTAL — the one step a person takes, and the only one.
//!
//! A bot reaches a guild exactly one way: somebody with `MANAGE_GUILD` opens
//! Discord's authorization page and installs the application. This module
//! builds that URL and nothing else. It does not, and cannot, complete the
//! flow — that is the point. Installing an app is a human act performed in a
//! browser session `OpenSesame` does not hold, which is why there is no
//! automation path here to accidentally leave open.
//!
//! Three protocol choices are deliberate and each closes a door:
//!
//! - **`scope=bot`, never `identify` or `guilds`.** Those scopes mint a user
//!   token. The function has no scope parameter, so it cannot ask for one;
//!   `applications.commands` is added only when a verb needs it, and it is an
//!   application scope, not a person's.
//! - **No `response_type=code` and no `redirect_uri`.** A bot install needs no
//!   code exchange. Requesting one would be requesting a grant on behalf of the
//!   installer, which is the user-token road under a different name.
//! - **`integration_type=0` (guild install).** Discord's user-install context
//!   attaches the application to the installing *person* and follows them
//!   across servers. Stating the guild context explicitly means a copied URL
//!   cannot quietly become a user install.
//!
//! The permission bitfield is the union of the requested verbs and nothing
//! more, and an elevated bitfield is refused here as well as at apply time —
//! an install URL is a durable artifact that gets pasted into chat and reused,
//! so the narrowest place to catch it is before it exists.

use url::Url;

use crate::model::ApplicationId;
use crate::permissions::Permissions;
use crate::refusal::Refusal;
use crate::verbs::{permissions_for, Verb};

/// Discord's authorization endpoint. Matches the `discord` entry in
/// `crates/connection-broker/src/catalog.json`, which is the same origin under
/// a different flow.
pub const DISCORD_AUTHORIZE_URL: &str = "https://discord.com/oauth2/authorize";

/// A bot-install invitation: the URL to open, plus a display-safe account of
/// what it asks for.
///
/// The summary exists so an operator screen can render the request without
/// re-deriving it from a bitfield, and so a reviewer can read the test
/// assertions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortalInvitation {
    url: Url,
    permissions: Permissions,
    scopes: Vec<&'static str>,
}

impl PortalInvitation {
    #[must_use]
    pub const fn url(&self) -> &Url {
        &self.url
    }

    #[must_use]
    pub const fn permissions(&self) -> Permissions {
        self.permissions
    }

    #[must_use]
    pub fn scopes(&self) -> &[&'static str] {
        &self.scopes
    }

    /// The permissions this invitation asks for, by name, for showing a person.
    #[must_use]
    pub fn requested_permission_names(&self) -> Vec<&'static str> {
        self.permissions.names()
    }
}

/// Build the bot-install URL for `verbs`.
///
/// # Errors
///
/// [`Refusal::NoVerbs`] for an empty list — an install asking for no
/// permissions is a mistake, not a minimal request — and
/// [`Refusal::ElevatedPermissions`] if the union somehow reaches an elevated
/// bit. The second is unreachable through [`Verb`] today and checked anyway:
/// [`Verb`] is the kind of table that gains a row later, and this is the guard
/// that makes that a test failure instead of a live admin invite.
pub fn install_invitation(
    application: &ApplicationId,
    verbs: &[Verb],
) -> Result<PortalInvitation, Refusal> {
    if verbs.is_empty() {
        return Err(Refusal::NoVerbs);
    }
    let permissions = permissions_for(verbs);
    if permissions.is_elevated() {
        return Err(Refusal::elevated(&permissions.elevated()));
    }

    let mut scopes = vec!["bot"];
    if verbs.contains(&Verb::CommandUse) {
        scopes.push("applications.commands");
    }

    let mut url = Url::parse(DISCORD_AUTHORIZE_URL).map_err(|_| Refusal::BaseUrlInsecure {
        url: DISCORD_AUTHORIZE_URL.to_owned(),
    })?;
    url.query_pairs_mut()
        .append_pair("client_id", application.as_str())
        .append_pair("scope", &scopes.join(" "))
        .append_pair("permissions", &permissions.to_string())
        .append_pair("integration_type", "0");

    Ok(PortalInvitation {
        url,
        permissions,
        scopes,
    })
}
