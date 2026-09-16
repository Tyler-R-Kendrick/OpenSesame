//! The plan vocabulary shared by COL-APPLY and COL-RECONCILE.
//!
//! Planning is a pure function of the projection plus the observed guild, and a
//! [`Plan`] is inspectable before anything is sent. That separation is what lets
//! the fixture suite assert "an unmanaged role survives" as a property of the
//! plan, and it is also what makes a dry run possible: the same function
//! produces the steps whether or not a transport ever sees them.
//!
//! [`Plan::untouched`] is not decoration. "Do not remove pre-existing roles
//! `OpenSesame` did not manage" is a claim about something that *did not* happen,
//! which is exactly the kind of claim a test cannot make by observing output.
//! So the plan records every role it saw on the member and chose to leave, and
//! the reconcile tests assert against that list.

use crate::model::{ChannelId, GuildId, RoleId, UserId};
use crate::permissions::Permissions;

/// Which role a step acts on.
///
/// [`RoleTarget::PendingCreate`] names the role the plan's own
/// [`Step::CreateRole`] will produce. The id does not exist at planning time,
/// so a plan cannot pretend to know it; the executor substitutes the id the
/// create returned, and refuses if there was no create.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoleTarget {
    PendingCreate,
    Existing(RoleId),
}

/// One protocol operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// `POST /guilds/{guild}/roles`. The role carries the verb bits and nothing
    /// else.
    CreateRole {
        name: String,
        permissions: Permissions,
    },
    /// `PATCH /guilds/{guild}/roles/{role}` — narrow or correct an owned role's
    /// permissions in place.
    UpdateRolePermissions {
        role: RoleId,
        permissions: Permissions,
    },
    /// `PUT /channels/{channel}/permissions/{role}` — the channel overwrite
    /// that scopes the role to a channel.
    SetChannelOverwrite {
        channel: ChannelId,
        role: RoleTarget,
        allow: Permissions,
        deny: Permissions,
    },
    /// `PUT /guilds/{guild}/members/{user}/roles/{role}`.
    AddMemberRole { user: UserId, role: RoleTarget },
    /// `DELETE /guilds/{guild}/members/{user}/roles/{role}`.
    RemoveMemberRole { user: UserId, role: RoleId },
    /// `DELETE /guilds/{guild}/roles/{role}`, for a role this adapter owns and
    /// no longer needs.
    DeleteRole { role: RoleId },
}

impl Step {
    /// A short label for logs and test failures.
    #[must_use]
    pub const fn label(&self) -> &'static str {
        match self {
            Self::CreateRole { .. } => "create_role",
            Self::UpdateRolePermissions { .. } => "update_role_permissions",
            Self::SetChannelOverwrite { .. } => "set_channel_overwrite",
            Self::AddMemberRole { .. } => "add_member_role",
            Self::RemoveMemberRole { .. } => "remove_member_role",
            Self::DeleteRole { .. } => "delete_role",
        }
    }
}

/// An ordered set of steps, with the reasoning a guild's audit log will carry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub guild: GuildId,
    /// The authority handle this plan serves. An identifier, never a value.
    pub authority_id: String,
    /// Sent as `X-Audit-Log-Reason` on every mutation, so a guild's own audit
    /// log links back to the authority without anybody having to ask
    /// `OpenSesame`.
    pub audit_reason: String,
    pub steps: Vec<Step>,
    /// Roles observed on the member that this plan deliberately did not touch.
    pub untouched: Vec<RoleId>,
}

impl Plan {
    #[must_use]
    pub fn is_noop(&self) -> bool {
        self.steps.is_empty()
    }

    #[must_use]
    pub fn labels(&self) -> Vec<&'static str> {
        self.steps.iter().map(Step::label).collect()
    }

    /// Whether the plan removes anything from the guild.
    ///
    /// Used by callers that want to require a human confirmation for a
    /// destructive reconcile.
    #[must_use]
    pub fn is_destructive(&self) -> bool {
        self.steps.iter().any(|step| {
            matches!(
                step,
                Step::RemoveMemberRole { .. } | Step::DeleteRole { .. }
            )
        })
    }
}

/// Discord truncates `X-Audit-Log-Reason` at 512 characters.
pub const MAX_AUDIT_REASON_CHARS: usize = 512;

/// The audit reason for an authority's changes.
///
/// ASCII only and truncated, because the header is sent verbatim: a
/// multi-byte character split by a byte-wise truncation is a malformed header,
/// and an authority handle is not a place for prose anyway.
#[must_use]
pub fn audit_reason(authority_id: &str, what: &str) -> String {
    let full = format!("OpenSesame authority {authority_id}: {what}");
    let sanitized: String = full
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '?'
            }
        })
        .take(MAX_AUDIT_REASON_CHARS)
        .collect();
    sanitized
}
