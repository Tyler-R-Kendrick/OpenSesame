//! One-line setup for a registered guild, a client pointed at the fixture, and
//! a projection to plan.
#![allow(dead_code)]

use chrono::{DateTime, Duration, TimeZone, Utc};
use opensesame_collab_adapter::{
    AuthorityProjection, ChannelId, CollabClient, GuildId, Platform, Registration, TargetSpec,
    UserId, Verb,
};

use super::transport::{bot_token, HyperTransport, RecordingBackoff};
use super::{Fixture, GuildState, CHANNEL_ID, GUILD_ID, SUBJECT_ID};

pub const APPLICATION_ID: &str = "950000000000000001";
/// The authority handle every scenario projects. Ends up in the role name as
/// `opensesame/auth-7` and in `X-Audit-Log-Reason`.
pub const AUTHORITY_ID: &str = "auth-7";

/// A fixed clock, so an expiry assertion is arithmetic rather than a race.
#[must_use]
pub fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 15, 12, 0, 0).unwrap()
}

pub struct Scenario {
    pub fixture: Fixture,
    pub registration: Registration,
    pub client: CollabClient<HyperTransport, RecordingBackoff>,
    pub backoff: RecordingBackoff,
}

impl Scenario {
    /// A guild registered with `CHANNEL_ID` in scope and nothing owned yet.
    pub async fn start(state: GuildState) -> Self {
        Self::with_channels(state, &[CHANNEL_ID]).await
    }

    pub async fn with_channels(state: GuildState, channels: &[&str]) -> Self {
        let fixture = super::spawn(state).await;
        let registration = Registration::register(TargetSpec {
            platform: Platform::Discord,
            guild: GuildId::new(GUILD_ID),
            application: opensesame_collab_adapter::ApplicationId::new(APPLICATION_ID),
            channels: channels.iter().map(|id| ChannelId::new(*id)).collect(),
            credential_kind: opensesame_collab_adapter::CredentialKind::BotToken,
            base_url: Some(fixture.base_url.clone()),
        })
        .expect("a loopback base url and a bot credential are accepted");
        let backoff = RecordingBackoff::default();
        let client = CollabClient::new(HyperTransport::new(), backoff.clone(), bot_token());
        Self {
            fixture,
            registration,
            client,
            backoff,
        }
    }

    /// Read the guild the way production does — roles, members, and each in-scope channel.
    pub async fn observe(&self) -> opensesame_collab_adapter::ObservedGuild {
        self.client
            .observe(&self.registration, &UserId::new(SUBJECT_ID))
            .await
            .expect("the fixture answers every read")
    }
}

/// A live projection for `verbs`, expiring an hour after [`now`].
#[must_use]
pub fn projection(verbs: &[Verb]) -> AuthorityProjection {
    AuthorityProjection {
        authority_id: AUTHORITY_ID.to_owned(),
        subject: UserId::new(SUBJECT_ID),
        guild: GuildId::new(GUILD_ID),
        channels: vec![ChannelId::new(CHANNEL_ID)],
        verbs: verbs.to_vec(),
        expires_at: now() + Duration::hours(1),
        revoked: false,
    }
}

/// The role name a projection for [`AUTHORITY_ID`] owns.
#[must_use]
pub fn owned_role_name() -> String {
    format!("opensesame/{AUTHORITY_ID}")
}
