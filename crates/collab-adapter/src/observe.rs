//! Read the guild state a plan is built from.
//!
//! One observation, in one pass, because planning is a pure function of what was
//! observed and a plan built from two different moments is a plan built from a
//! state that never existed:
//!
//! 1. `GET /users/@me` — who this bot is. Needed because Discord's hierarchy
//!    rule is about *the bot's own* highest role, and a bot cannot look that up
//!    without knowing its user id.
//! 2. `GET /guilds/{guild}/roles` — every role and its position.
//! 3. `GET /guilds/{guild}/members/{bot}` — the bot's roles, whose maximum
//!    position is the ceiling every mutation is checked against.
//! 4. `GET /guilds/{guild}/members/{subject}` — the member being projected onto.
//! 5. `GET /channels/{channel}` for each in-scope channel — the existing
//!    overwrites, so a re-apply can tell that one already says what it wants.
//!    Without this read, `plan_apply` would be idempotent on the wire but not in
//!    its plan, and every reconciliation cycle would re-`PUT` every overwrite for
//!    every authority.
//!
//! The bot's ceiling is derived here rather than configured. A configured
//! position goes stale the first time somebody drags a role in the Discord UI,
//! and a stale ceiling means the planner approves a mutation the API will refuse
//! — a 403 with `code: 50013` and no explanation of which role was too senior.

use serde::Deserialize;

use crate::executor::{Backoff, CollabClient, ExecutionError};
use crate::model::{ObservedGuild, ObservedRole, UserId};
use crate::registry::Registration;
use crate::transport::CollabTransport;
use crate::wire::{self, Route};
use crate::{model, transport::Method};

#[derive(Debug, Deserialize)]
struct CurrentUser {
    id: UserId,
}

/// `GET /users/@me`
#[must_use]
fn get_current_user() -> Route {
    Route {
        method: Method::Get,
        path: "/users/@me".to_owned(),
        body: None,
    }
}

impl<T: CollabTransport, B: Backoff> CollabClient<T, B> {
    /// The bot's own user id.
    ///
    /// # Errors
    ///
    /// [`ExecutionError`] from the read, or [`ExecutionError::Decode`] if
    /// `/users/@me` does not answer with a user.
    pub async fn current_user(
        &self,
        registration: &Registration,
    ) -> Result<UserId, ExecutionError> {
        let (response, _) = self
            .send(registration, &get_current_user(), None, "current_user")
            .await?;
        serde_json::from_slice::<CurrentUser>(&response.body)
            .map(|user| user.id)
            .map_err(|error| ExecutionError::Decode {
                step: "current_user",
                detail: error.to_string(),
            })
    }

    /// Read everything a plan needs, as one observation.
    ///
    /// # Errors
    ///
    /// Any [`ExecutionError`] from the reads. A missing member is Discord's
    /// `10007 Unknown Member` and surfaces as [`ExecutionError::Api`] — an
    /// authority for somebody who is not in the guild is a real problem and not
    /// something to treat as an empty role list.
    pub async fn observe(
        &self,
        registration: &Registration,
        subject: &UserId,
    ) -> Result<ObservedGuild, ExecutionError> {
        let guild = registration.guild();
        let bot = self.current_user(registration).await?;

        let (roles_response, _) = self
            .send(
                registration,
                &wire::get_guild_roles(guild),
                None,
                "get_guild_roles",
            )
            .await?;
        let roles =
            wire::parse_roles(&roles_response.body).map_err(|detail| ExecutionError::Decode {
                step: "get_guild_roles",
                detail,
            })?;

        let bot_member = self.member(registration, &bot, "get_bot_member").await?;
        let member = self
            .member(registration, subject, "get_guild_member")
            .await?;

        let mut channels = Vec::with_capacity(registration.channels().len());
        for channel in registration.channels() {
            channels.push(self.channel(registration, channel).await?);
        }

        Ok(ObservedGuild {
            guild: guild.clone(),
            bot_highest_position: highest_position(&roles, &bot_member.roles),
            roles,
            channels,
            member,
        })
    }

    /// One in-scope channel's overwrites.
    ///
    /// # Errors
    ///
    /// Any [`ExecutionError`] from the read.
    async fn channel(
        &self,
        registration: &Registration,
        channel: &model::ChannelId,
    ) -> Result<model::ObservedChannel, ExecutionError> {
        let (response, _) = self
            .send(
                registration,
                &wire::get_channel(channel),
                None,
                "get_channel",
            )
            .await?;
        wire::parse_channel(&response.body).map_err(|detail| ExecutionError::Decode {
            step: "get_channel",
            detail,
        })
    }

    /// # Errors
    ///
    /// Any [`ExecutionError`] from the read.
    async fn member(
        &self,
        registration: &Registration,
        user: &UserId,
        step: &'static str,
    ) -> Result<model::ObservedMember, ExecutionError> {
        let (response, _) = self
            .send(
                registration,
                &wire::get_guild_member(registration.guild(), user),
                None,
                step,
            )
            .await?;
        wire::parse_member(&response.body).map_err(|detail| ExecutionError::Decode { step, detail })
    }
}

/// The highest position among `held`, or zero.
///
/// Zero is the right floor and it fails closed: `@everyone` is position 0, so a
/// bot with no roles has a ceiling of 0, and
/// [`crate::apply::assert_mutable`]'s `position >= ceiling` check then refuses
/// every role. A bot with no roles genuinely cannot manage anything.
#[must_use]
pub fn highest_position(roles: &[ObservedRole], held: &[model::RoleId]) -> u32 {
    roles
        .iter()
        .filter(|role| held.contains(&role.id))
        .map(|role| role.position)
        .max()
        .unwrap_or(0)
}
