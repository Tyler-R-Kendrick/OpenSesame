//! Discord's REST dialect: routes, bodies, and the error codes worth naming.
//!
//! Kept in one place so the protocol is auditable as a unit and so
//! `tests/support` can be a fixture of *this*, rather than of whatever the
//! caller happened to send. Everything here is v10 (`/api/v10`); an unversioned
//! Discord path is a moving target.
//!
//! The details that bite:
//!
//! - `permissions`, `allow`, and `deny` are **decimal strings** on the wire.
//!   See [`crate::permissions`].
//! - A channel permission overwrite is keyed by the *overwrite target's* id with
//!   a `type` discriminator: `0` for a role, `1` for a member. This adapter only
//!   ever writes `0`. Writing `1` would put an authority directly on a person,
//!   leaving nothing named in the role list and nothing to revoke.
//! - Role and member mutations answer `204 No Content`. A parser expecting JSON
//!   fails on success.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::model::{
    ChannelId, GuildId, ObservedChannel, ObservedMember, ObservedOverwrite, ObservedRole, RoleId,
    UserId,
};
use crate::permissions::Permissions;
use crate::transport::Method;

/// The overwrite `type` for a role.
const OVERWRITE_TYPE_ROLE: u8 = 0;

/// One route: a method, a path below the API base, and an optional JSON body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub method: Method,
    pub path: String,
    pub body: Option<Value>,
}

/// `GET /guilds/{guild}/roles`
#[must_use]
pub fn get_guild_roles(guild: &GuildId) -> Route {
    Route {
        method: Method::Get,
        path: format!("/guilds/{guild}/roles"),
        body: None,
    }
}

/// `GET /guilds/{guild}/members/{user}`
#[must_use]
pub fn get_guild_member(guild: &GuildId, user: &UserId) -> Route {
    Route {
        method: Method::Get,
        path: format!("/guilds/{guild}/members/{user}"),
        body: None,
    }
}

/// `GET /channels/{channel}`
///
/// Read for its `permission_overwrites` only. There is no route that returns one
/// overwrite, so the channel object is the narrowest read available.
#[must_use]
pub fn get_channel(channel: &ChannelId) -> Route {
    Route {
        method: Method::Get,
        path: format!("/channels/{channel}"),
        body: None,
    }
}

/// `POST /guilds/{guild}/roles`
///
/// `hoist` and `mentionable` are false and the colour is left at Discord's
/// default. A managed authority role is plumbing: it should not reorder the
/// member sidebar or become a thing people can ping.
#[must_use]
pub fn create_role(guild: &GuildId, name: &str, permissions: Permissions) -> Route {
    Route {
        method: Method::Post,
        path: format!("/guilds/{guild}/roles"),
        body: Some(json!({
            "name": name,
            "permissions": permissions.to_string(),
            "hoist": false,
            "mentionable": false,
        })),
    }
}

/// `PATCH /guilds/{guild}/roles/{role}` — permissions only.
///
/// Deliberately not a general role edit. Sending only `permissions` means a
/// name, colour, or icon a person set on the role survives this adapter
/// correcting the bits.
#[must_use]
pub fn update_role_permissions(guild: &GuildId, role: &RoleId, permissions: Permissions) -> Route {
    Route {
        method: Method::Patch,
        path: format!("/guilds/{guild}/roles/{role}"),
        body: Some(json!({ "permissions": permissions.to_string() })),
    }
}

/// `DELETE /guilds/{guild}/roles/{role}`
#[must_use]
pub fn delete_role(guild: &GuildId, role: &RoleId) -> Route {
    Route {
        method: Method::Delete,
        path: format!("/guilds/{guild}/roles/{role}"),
        body: None,
    }
}

/// `PUT /guilds/{guild}/members/{user}/roles/{role}`
#[must_use]
pub fn add_member_role(guild: &GuildId, user: &UserId, role: &RoleId) -> Route {
    Route {
        method: Method::Put,
        path: format!("/guilds/{guild}/members/{user}/roles/{role}"),
        body: None,
    }
}

/// `DELETE /guilds/{guild}/members/{user}/roles/{role}`
#[must_use]
pub fn remove_member_role(guild: &GuildId, user: &UserId, role: &RoleId) -> Route {
    Route {
        method: Method::Delete,
        path: format!("/guilds/{guild}/members/{user}/roles/{role}"),
        body: None,
    }
}

/// `PUT /channels/{channel}/permissions/{role}` with `type: 0`.
#[must_use]
pub fn put_channel_overwrite(
    channel: &ChannelId,
    role: &RoleId,
    allow: Permissions,
    deny: Permissions,
) -> Route {
    Route {
        method: Method::Put,
        path: format!("/channels/{channel}/permissions/{role}"),
        body: Some(json!({
            "type": OVERWRITE_TYPE_ROLE,
            "allow": allow.to_string(),
            "deny": deny.to_string(),
        })),
    }
}

/// A role as Discord serializes it.
#[derive(Clone, Debug, Deserialize)]
struct RolePayload {
    id: RoleId,
    name: String,
    permissions: Permissions,
    position: u32,
    #[serde(default)]
    managed: bool,
}

impl From<RolePayload> for ObservedRole {
    fn from(payload: RolePayload) -> Self {
        Self {
            id: payload.id,
            name: payload.name,
            permissions: payload.permissions,
            position: payload.position,
            integration_managed: payload.managed,
        }
    }
}

/// Parse `GET /guilds/{guild}/roles`.
///
/// # Errors
///
/// The serde message, verbatim. A role list that will not parse is a protocol
/// mismatch worth reading, not something to default around.
pub fn parse_roles(body: &[u8]) -> Result<Vec<ObservedRole>, String> {
    serde_json::from_slice::<Vec<RolePayload>>(body)
        .map(|roles| roles.into_iter().map(ObservedRole::from).collect())
        .map_err(|error| error.to_string())
}

/// Parse a single role, as `POST /guilds/{guild}/roles` answers.
///
/// # Errors
///
/// The serde message, verbatim.
pub fn parse_role(body: &[u8]) -> Result<ObservedRole, String> {
    serde_json::from_slice::<RolePayload>(body)
        .map(ObservedRole::from)
        .map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Deserialize)]
struct ChannelPayload {
    id: ChannelId,
    #[serde(default)]
    permission_overwrites: Vec<OverwritePayload>,
}

#[derive(Clone, Debug, Deserialize)]
struct OverwritePayload {
    id: RoleId,
    /// Discord sends `0` or `1`. Older payloads sent `"role"`/`"member"`, so an
    /// unreadable discriminator defaults to `1` (member) — the value this adapter
    /// ignores. Defaulting to `0` would make it treat an unknown entry as a role
    /// overwrite it may reason about.
    #[serde(rename = "type", default = "member_kind")]
    kind: u8,
    allow: Permissions,
    deny: Permissions,
}

const fn member_kind() -> u8 {
    1
}

/// Parse `GET /channels/{channel}`, keeping only the overwrite list.
///
/// # Errors
///
/// The serde message, verbatim.
pub fn parse_channel(body: &[u8]) -> Result<ObservedChannel, String> {
    let payload: ChannelPayload = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    Ok(ObservedChannel {
        id: payload.id,
        overwrites: payload
            .permission_overwrites
            .into_iter()
            .map(|overwrite| ObservedOverwrite {
                target: overwrite.id,
                kind: overwrite.kind,
                allow: overwrite.allow,
                deny: overwrite.deny,
            })
            .collect(),
    })
}

#[derive(Clone, Debug, Deserialize)]
struct MemberPayload {
    user: MemberUser,
    #[serde(default)]
    roles: Vec<RoleId>,
}

#[derive(Clone, Debug, Deserialize)]
struct MemberUser {
    id: UserId,
}

/// Parse `GET /guilds/{guild}/members/{user}`.
///
/// # Errors
///
/// The serde message, verbatim.
pub fn parse_member(body: &[u8]) -> Result<ObservedMember, String> {
    serde_json::from_slice::<MemberPayload>(body)
        .map(|payload| ObservedMember {
            user: payload.user.id,
            roles: payload.roles,
        })
        .map_err(|error| error.to_string())
}

/// Discord's JSON error body.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub code: u32,
    #[serde(default)]
    pub message: String,
}

/// `Missing Permissions` — what a bot gets for touching a role at or above its
/// own highest position. Named because the planner tries to refuse this case
/// first, and seeing it anyway means the observed hierarchy was stale.
pub const CODE_MISSING_PERMISSIONS: u32 = 50_013;
/// `Missing Access` — the bot is not in the guild, or cannot see the channel.
pub const CODE_MISSING_ACCESS: u32 = 50_001;
/// `Unknown Role`.
pub const CODE_UNKNOWN_ROLE: u32 = 10_011;
/// `Maximum number of guild roles reached` (250).
pub const CODE_MAX_ROLES: u32 = 30_005;

impl ApiError {
    /// Parse an error body, falling back to the status when it is not JSON.
    #[must_use]
    pub fn parse(status: u16, body: &[u8]) -> Self {
        serde_json::from_slice::<Self>(body).unwrap_or_else(|_| Self {
            code: 0,
            message: format!("HTTP {status}"),
        })
    }
}
