//! The closed verb catalogue — the reason "refuse admin roles" is a property of
//! the type system here rather than a check somewhere.
//!
//! A projection names verbs from [`Verb`], and a verb's permission mask is
//! fixed in this file. There is no constructor that takes a raw bitfield, so a
//! caller — an agent, a route, a future swarm — cannot express
//! `ADMINISTRATOR` at all: the widest thing sayable is the union of every verb
//! below, and [`Verb::widest`] is asserted non-elevated by
//! `tests/refusals.rs`. Adding a verb whose mask intersects
//! [`crate::permissions::ELEVATED`] fails that test, which is the intended
//! tripwire.
//!
//! Verb names are the dotted action strings the host plane already uses on
//! `Grant::actions` (`repository.read`, `pull_request.create`), so the mapping
//! from an authority's verbs to a guild's bits is a lookup rather than a
//! translation layer.

use serde::{Deserialize, Serialize};

use crate::permissions::{
    Permissions, ADD_REACTIONS, ATTACH_FILES, CONNECT, CREATE_PUBLIC_THREADS, EMBED_LINKS,
    READ_MESSAGE_HISTORY, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS, SPEAK, USE_APPLICATION_COMMANDS,
    VIEW_CHANNEL,
};

/// A verb an authority can project onto a Discord guild.
///
/// Deliberately small. Every entry is something a collaborator *does* in a
/// channel; nothing here acts on a person (kick, ban, timeout, nickname), on
/// another person's content (delete, pin, archive), or on the guild's own
/// structure (roles, channels, webhooks, integrations). Those are not missing
/// features — an authority projection that could perform them could also
/// rewrite the graph that bounds it.
/// The serialized form is the dotted action string, so the wire vocabulary and
/// [`Verb::as_action`] cannot drift apart — `tests/refusals.rs` asserts they
/// agree for every variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Verb {
    /// Read a channel and its backlog.
    #[serde(rename = "channel.read")]
    ChannelRead,
    /// Post a message, with link embeds.
    #[serde(rename = "channel.post")]
    ChannelPost,
    /// Post a message with an attachment.
    #[serde(rename = "channel.attach")]
    ChannelAttach,
    /// React to somebody else's message.
    #[serde(rename = "channel.react")]
    ChannelReact,
    /// Reply inside an existing thread.
    #[serde(rename = "thread.reply")]
    ThreadReply,
    /// Open a public thread. Private threads are absent on purpose: a thread
    /// nobody else can see is a side channel, and an authority projection
    /// should not be able to create one.
    #[serde(rename = "thread.open")]
    ThreadOpen,
    /// Join a voice channel without speaking.
    #[serde(rename = "voice.join")]
    VoiceJoin,
    /// Speak in a voice channel.
    #[serde(rename = "voice.speak")]
    VoiceSpeak,
    /// Invoke the guild's application commands.
    #[serde(rename = "command.use")]
    CommandUse,
}

impl Verb {
    /// Every verb, in a stable order. Stable because plans, audit reasons, and
    /// the portal bitfield all derive from it, and a reordering would churn
    /// them for no reason.
    pub const ALL: &'static [Self] = &[
        Self::ChannelRead,
        Self::ChannelPost,
        Self::ChannelAttach,
        Self::ChannelReact,
        Self::ThreadReply,
        Self::ThreadOpen,
        Self::VoiceJoin,
        Self::VoiceSpeak,
        Self::CommandUse,
    ];

    /// The dotted action string this verb is named by on the wire and in an
    /// authority's `actions` list.
    #[must_use]
    pub const fn as_action(self) -> &'static str {
        match self {
            Self::ChannelRead => "channel.read",
            Self::ChannelPost => "channel.post",
            Self::ChannelAttach => "channel.attach",
            Self::ChannelReact => "channel.react",
            Self::ThreadReply => "thread.reply",
            Self::ThreadOpen => "thread.open",
            Self::VoiceJoin => "voice.join",
            Self::VoiceSpeak => "voice.speak",
            Self::CommandUse => "command.use",
        }
    }

    /// The Discord permission bits this verb needs, and no others.
    ///
    /// `VIEW_CHANNEL` recurs because Discord evaluates it independently: a
    /// member allowed `SEND_MESSAGES` in a channel they cannot view sends
    /// nothing, and the resulting 403 looks like a bug in this adapter rather
    /// than an incomplete grant.
    #[must_use]
    pub const fn permissions(self) -> Permissions {
        Permissions::from_bits(match self {
            Self::ChannelRead => VIEW_CHANNEL | READ_MESSAGE_HISTORY,
            Self::ChannelPost => VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS,
            Self::ChannelAttach => VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES,
            Self::ChannelReact => VIEW_CHANNEL | READ_MESSAGE_HISTORY | ADD_REACTIONS,
            Self::ThreadReply => VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES_IN_THREADS,
            Self::ThreadOpen => {
                VIEW_CHANNEL
                    | READ_MESSAGE_HISTORY
                    | CREATE_PUBLIC_THREADS
                    | SEND_MESSAGES_IN_THREADS
            }
            Self::VoiceJoin => VIEW_CHANNEL | CONNECT,
            Self::VoiceSpeak => VIEW_CHANNEL | CONNECT | SPEAK,
            Self::CommandUse => VIEW_CHANNEL | USE_APPLICATION_COMMANDS,
        })
    }

    /// Resolve a dotted action string.
    ///
    /// `None` for anything not in the catalogue. Callers must treat that as a
    /// refusal rather than skipping the verb: an authority that says
    /// `guild.administrate` and gets a plan back with that line silently
    /// dropped has been told "done" about something that did not happen.
    #[must_use]
    pub fn parse(action: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|verb| verb.as_action() == action)
    }

    /// The union of every verb in the catalogue — the widest permission set
    /// this adapter can ever request, for a guild or for its own bot install.
    #[must_use]
    pub fn widest() -> Permissions {
        Self::ALL
            .iter()
            .fold(Permissions::NONE, |acc, verb| acc.union(verb.permissions()))
    }
}

/// The permission set a list of verbs adds up to.
#[must_use]
pub fn permissions_for(verbs: &[Verb]) -> Permissions {
    verbs
        .iter()
        .fold(Permissions::NONE, |acc, verb| acc.union(verb.permissions()))
}
