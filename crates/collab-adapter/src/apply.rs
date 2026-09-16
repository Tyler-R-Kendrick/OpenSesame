//! COL-APPLY — turn a live projection into an ordered plan.
//!
//! ## Why the order is the order
//!
//! 1. **Create or correct the role**, carrying only the verb bits.
//! 2. **Write the channel overwrites**, so the role's reach is bounded before
//!    anybody holds it.
//! 3. **Add the member to the role**, last.
//!
//! Reversing 2 and 3 opens a window — usually milliseconds, occasionally much
//! longer behind a rate limit — in which the subject holds a role whose channel
//! scope has not been written yet. On a guild whose `@everyone` role can view
//! channels by default, that window is a real over-grant, and it is invisible
//! afterwards. So the ordering is a correctness property, and `tests/apply.rs`
//! asserts the sequence rather than the set.
//!
//! ## Convergence
//!
//! Planning is a diff, not a script: a projection that is already reflected in
//! the guild plans nothing. That needs the observed overwrites as well as the
//! observed roles, which is why [`crate::observe`] reads each in-scope channel.
//! Skipping that read would leave `plan_apply` idempotent on the wire — every
//! step is a `PUT` or a `PATCH` — but not in its plan, so every reconciliation
//! cycle would re-send every overwrite for every authority, against the routes
//! Discord rate-limits hardest.
//!
//! ## What this refuses
//!
//! - A dead authority ([`AuthorityProjection::assert_live`]) — an expired grant
//!   is a reconcile, and asking apply to handle it would mean apply deciding
//!   what to delete.
//! - An unregistered guild or an out-of-scope channel.
//! - An existing role at or above the bot's position, or one an integration
//!   manages — both would fail upstream with a 403 that says nothing.
//! - An existing same-named role this adapter does not own. That is the
//!   ownership rule doing its job in the apply direction: a person's
//!   `opensesame/…` role is not quietly adopted and rewritten.

use chrono::{DateTime, Utc};

use crate::model::{AuthorityProjection, ChannelId, ObservedGuild, ObservedRole, RoleId};
use crate::permissions::Permissions;
use crate::plan::{audit_reason, Plan, RoleTarget, Step};
use crate::refusal::Refusal;
use crate::registry::Registration;
use crate::verbs::permissions_for;

/// Plan the guild changes a live projection implies.
///
/// # Errors
///
/// Any [`Refusal`] named in the module docs. Nothing is sent, so a refusal
/// leaves the guild exactly as it was.
pub fn plan_apply(
    registration: &Registration,
    projection: &AuthorityProjection,
    observed: &ObservedGuild,
    now: DateTime<Utc>,
) -> Result<Plan, Refusal> {
    projection.assert_live(now)?;
    assert_target_matches(registration, projection, observed)?;

    let permissions = permissions_for(&projection.verbs);
    if permissions.is_empty() {
        return Err(Refusal::NoVerbs);
    }
    if permissions.is_elevated() {
        return Err(Refusal::elevated(&permissions.elevated()));
    }
    for channel in &projection.channels {
        registration.assert_channel_in_scope(channel)?;
    }

    let role_name = projection.owned_role_name();
    let mut steps = Vec::new();
    let target = role_target(registration, observed, &role_name, permissions, &mut steps)?;

    steps.extend(overwrite_steps(observed, projection, &target, permissions));

    if !matches!(&target, RoleTarget::Existing(id) if member_holds(observed, id)) {
        steps.push(Step::AddMemberRole {
            user: projection.subject.clone(),
            role: target,
        });
    }

    Ok(Plan {
        guild: projection.guild.clone(),
        authority_id: projection.authority_id.clone(),
        audit_reason: audit_reason(&projection.authority_id, "apply collaboration authority"),
        steps,
        untouched: untouched_roles(registration, observed, &role_name),
    })
}

/// Find the authority's own role, or plan to create it, pushing whatever the
/// choice implies onto `steps`.
///
/// An existing role is corrected in place rather than deleted and recreated: a
/// recreate would change the role id, and every channel overwrite in the guild
/// keyed by the old id would silently stop applying.
///
/// # Errors
///
/// Whatever [`assert_mutable`] refuses.
fn role_target(
    registration: &Registration,
    observed: &ObservedGuild,
    role_name: &str,
    permissions: Permissions,
    steps: &mut Vec<Step>,
) -> Result<RoleTarget, Refusal> {
    let Some(role) = observed.role_named(role_name) else {
        steps.push(Step::CreateRole {
            name: role_name.to_owned(),
            permissions,
        });
        return Ok(RoleTarget::PendingCreate);
    };
    assert_mutable(registration, role, observed.bot_highest_position)?;
    if role.permissions != permissions {
        steps.push(Step::UpdateRolePermissions {
            role: role.id.clone(),
            permissions,
        });
    }
    Ok(RoleTarget::Existing(role.id.clone()))
}

/// The overwrite for each in-scope channel that does not already have it.
///
/// `deny` is empty on purpose. An overwrite that denies bits would be this
/// adapter making a decision about permissions the guild's own hierarchy
/// grants, which is not its call: the job is to add exactly the verb bits on
/// exactly the named channels, and to take away nothing anybody else
/// configured.
fn overwrite_steps(
    observed: &ObservedGuild,
    projection: &AuthorityProjection,
    role: &RoleTarget,
    allow: Permissions,
) -> Vec<Step> {
    projection
        .channels
        .iter()
        .filter(|channel| !overwrite_is_current(observed, channel, role, allow))
        .map(|channel| Step::SetChannelOverwrite {
            channel: channel.clone(),
            role: role.clone(),
            allow,
            deny: Permissions::NONE,
        })
        .collect()
}

/// Whether the channel already carries exactly the overwrite this plan would
/// write.
///
/// A role that does not exist yet has no overwrite, so a pending create always
/// needs one. Comparing the observed overwrite — rather than inferring from
/// "did we just touch the role" — also repairs an overwrite a person deleted by
/// hand, which is the case an inference would miss.
fn overwrite_is_current(
    observed: &ObservedGuild,
    channel: &ChannelId,
    role: &RoleTarget,
    allow: Permissions,
) -> bool {
    let RoleTarget::Existing(role) = role else {
        return false;
    };
    observed
        .channel(channel)
        .and_then(|channel| channel.role_overwrite(role))
        .is_some_and(|overwrite| overwrite.allow == allow && overwrite.deny == Permissions::NONE)
}

fn member_holds(observed: &ObservedGuild, role: &RoleId) -> bool {
    observed.member.roles.iter().any(|held| held == role)
}

/// The member's other roles, recorded so the plan states what it left behind.
fn untouched_roles(
    registration: &Registration,
    observed: &ObservedGuild,
    owned_role_name: &str,
) -> Vec<RoleId> {
    observed
        .member
        .roles
        .iter()
        .filter(|held| match observed.role(held) {
            Some(role) => !registration.owns(role) || role.name != owned_role_name,
            // A role id on the member that the roles list does not describe.
            // Unknown means not ours.
            None => true,
        })
        .cloned()
        .collect()
}

/// # Errors
///
/// [`Refusal::GuildNotRegistered`] when the observation is of another guild, and
/// [`Refusal::SubjectMismatch`] when it is of another member. Both mean the
/// caller read the wrong state, and planning against the wrong state is how a
/// role lands on the wrong person.
fn assert_target_matches(
    registration: &Registration,
    projection: &AuthorityProjection,
    observed: &ObservedGuild,
) -> Result<(), Refusal> {
    if registration.guild() != &projection.guild || observed.guild != projection.guild {
        return Err(Refusal::GuildNotRegistered {
            guild: projection.guild.clone(),
        });
    }
    if observed.member.user != projection.subject {
        return Err(Refusal::SubjectMismatch {
            expected: projection.subject.clone(),
            observed: observed.member.user.clone(),
        });
    }
    Ok(())
}

/// Whether an existing role may be changed at all.
///
/// # Errors
///
/// [`Refusal::RoleNotOwned`], [`Refusal::RoleIntegrationManaged`],
/// [`Refusal::RoleAboveBot`], or [`Refusal::ElevatedPermissions`].
pub(crate) fn assert_mutable(
    registration: &Registration,
    role: &ObservedRole,
    bot_highest_position: u32,
) -> Result<(), Refusal> {
    registration.assert_owns(role)?;
    if role.integration_managed {
        return Err(Refusal::RoleIntegrationManaged {
            role: role.id.clone(),
        });
    }
    if role.position >= bot_highest_position {
        return Err(Refusal::RoleAboveBot {
            role: role.id.clone(),
            position: role.position,
            bot_position: bot_highest_position,
        });
    }
    if role.permissions.is_elevated() {
        // An owned role that has acquired an elevated bit — by a person editing
        // it, or by a Discord default changing — is not something to quietly
        // patch back into shape. Refuse, and let a human look at it.
        return Err(Refusal::elevated(&role.permissions.elevated()));
    }
    Ok(())
}
