//! COL-RECONCILE — converge a guild on the live projections, and touch nothing
//! else.
//!
//! ## The rule that matters
//!
//! A reconciler's failure mode is not under-provisioning; it is walking into a
//! real server with a partial view of the desired state and deleting what it
//! does not recognise. So this one **only ever removes a role it created**, as
//! proved by both halves of [`Registration::owns`]. Every other role on the
//! member — the guild's own roles, another integration's roles, a role a person
//! renamed out of our namespace — is copied into [`Plan::untouched`] and left
//! exactly where it was.
//!
//! Concretely, given a member holding `@moderator`, `@nitro-booster`, and
//! `opensesame/auth-7`, reconciling with no live authorities removes
//! `opensesame/auth-7` and lists the other two as untouched. It does not need to
//! know what they are, and it never asks.
//!
//! ## Ordering, again
//!
//! Removal is the mirror of apply: **take the role off the member first, then
//! delete the role.** If the delete went first, a rate-limited or failed second
//! call would leave a member holding a role id that no longer resolves, which
//! Discord tolerates and humans find inexplicable. Taking the membership away
//! first means the authority is revoked in effect after step one, and the role
//! deletion is only cleanup.

use crate::apply::assert_mutable;
use crate::model::{ObservedGuild, ObservedRole, RoleId};
use crate::plan::{audit_reason, Plan, Step};
use crate::refusal::Refusal;
use crate::registry::Registration;

/// What a reconcile does with an owned role that is no longer wanted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sweep {
    /// Take the role off the member and leave the role in the guild. The
    /// default: the role is empty, harmless, and cheap to reuse on the next
    /// apply.
    Unassign,
    /// Take the role off the member and delete the role.
    UnassignAndDelete,
}

/// Plan the removals needed to converge on `live_role_names`.
///
/// `live_role_names` is the set of owned role names that should survive — the
/// [`crate::model::AuthorityProjection::owned_role_name`] of every authority the
/// caller still considers live. An empty set is a full revocation of this
/// adapter's own roles, and still nothing else.
///
/// # Errors
///
/// [`Refusal::GuildNotRegistered`] when the observation is of another guild. A
/// role that turns out to be immutable ([`Refusal::RoleAboveBot`],
/// [`Refusal::RoleIntegrationManaged`], an elevated bit) is **skipped and
/// recorded as untouched**, not raised: one stuck role must not stop the rest
/// of a revocation from proceeding.
pub fn plan_reconcile(
    registration: &Registration,
    observed: &ObservedGuild,
    live_role_names: &[String],
    sweep: Sweep,
) -> Result<Plan, Refusal> {
    if registration.guild() != &observed.guild {
        return Err(Refusal::GuildNotRegistered {
            guild: observed.guild.clone(),
        });
    }

    let mut steps = Vec::new();
    let mut untouched = Vec::new();

    for held in &observed.member.roles {
        match observed.role(held) {
            Some(role) if is_removable(registration, role, live_role_names, observed) => {
                steps.push(Step::RemoveMemberRole {
                    user: observed.member.user.clone(),
                    role: role.id.clone(),
                });
                if sweep == Sweep::UnassignAndDelete {
                    steps.push(Step::DeleteRole {
                        role: role.id.clone(),
                    });
                }
            }
            _ => untouched.push(held.clone()),
        }
    }

    Ok(Plan {
        guild: observed.guild.clone(),
        authority_id: registration.guild().to_string(),
        audit_reason: audit_reason(
            registration.guild().as_str(),
            "reconcile collaboration authority",
        ),
        steps,
        untouched,
    })
}

/// Owned roles this adapter created that no live authority still needs.
///
/// Separate from the member walk because a role can outlive its assignment: an
/// [`Sweep::Unassign`] reconcile leaves the role behind, and a later sweep
/// should be able to find it.
#[must_use]
pub fn orphaned_owned_roles(
    registration: &Registration,
    observed: &ObservedGuild,
    live_role_names: &[String],
) -> Vec<RoleId> {
    observed
        .roles
        .iter()
        .filter(|role| registration.owns(role) && !live_role_names.contains(&role.name))
        .filter(|role| assert_mutable(registration, role, observed.bot_highest_position).is_ok())
        .map(|role| role.id.clone())
        .collect()
}

/// Whether a held role is one this adapter may remove.
///
/// Every condition has to hold, and the order is cheapest-first:
///
/// - the registration owns it (ledger **and** name prefix),
/// - no live authority still wants that role name,
/// - it is mutable at all — below the bot, not integration-managed, not
///   carrying an elevated bit.
fn is_removable(
    registration: &Registration,
    role: &ObservedRole,
    live_role_names: &[String],
    observed: &ObservedGuild,
) -> bool {
    registration.owns(role)
        && !live_role_names.contains(&role.name)
        && assert_mutable(registration, role, observed.bot_highest_position).is_ok()
}
