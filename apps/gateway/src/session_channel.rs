//! What may cross a shared session's channel, and who each thing reaches
//! (ADR 0079 §2).
//!
//! The whole point of this module is a type that **cannot** carry the things
//! ADR 0079 forbids on this surface. Not "does not today" — cannot. Every
//! field of every [`SessionEvent`] variant is an opaque id, a closed enum, or
//! a timestamp. There is no `String` field anywhere in the type, so an item
//! label, a vault name, a note somebody typed, a token or a secret has nowhere
//! to sit, however carelessly a future variant is added. Adding one would
//! require adding the field, which is a diff a reviewer sees.
//!
//! This mirrors `crates/lifecycle`'s `ExpirySubject`, which is value-blind for
//! the same reason and by the same means. The test at the bottom is the fence:
//! it walks every variant, serializes it, and asserts every string in the
//! output is an id or a known discriminant.
//!
//! **Two things the transport is not.**
//!
//! It is not an authorization surface. A message arriving here is a request
//! like any other; nothing in this module reads standing off an inbound frame.
//! Authorization is [`crate::shared_session_fence`]'s, asked against the
//! Host's own store.
//!
//! It is not a broadcast bus. [`Delivery::for_recipient`] is asked separately
//! for every connected participant at send time, so a row-scoped participant
//! never learns that an item they cannot reach was opened, and a participant
//! whose grant lapsed or was withdrawn between the event and the send does not
//! receive it. Fan-out that computed its audience once and reused it would be
//! a revocation that takes effect at the next reconnect.

use chrono::{DateTime, Utc};
use opensesame_domain::{
    JoinRequestId, PrincipalId, SessionGrantId, SessionMode, SessionRole, VaultId, VaultItemId,
};
use serde::Serialize;

/// Serialize an id in its canonical, prefixed spelling.
///
/// `opaque_id!` derives `#[serde(transparent)]`, so a plain derive would put a
/// bare UUID on this channel while every HTTP route in this feature puts
/// `principal:<uuid>`. One id with two spellings across two surfaces of the
/// same feature is a defect a client author pays for, so the channel matches
/// the routes. The fields stay typed — this changes how they are written, not
/// what they can hold, and the structural fence below is untouched.
fn canonical<S, T>(value: &T, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
    T: std::fmt::Display,
{
    serializer.collect_str(value)
}

/// Something that happened in a shared session.
///
/// Ids only, deliberately. Each client renders the labels it can already
/// decrypt; a client that cannot decrypt an item has no business being told
/// what it is called (ADR 0079 §2 — this is the leak most likely to be got
/// wrong, because "Tyler opened AWS root credentials" reads like a courtesy).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// Somebody with live standing connected.
    ///
    /// Carries the mode they are seated in, not a role. A role belongs to a
    /// grant, and presence is no longer a grant — that is the whole of the
    /// coordination change. The old shape had to invent one, and what it
    /// invented for an operator was `write`, which announced the person who
    /// runs the session as somebody who writes the vault through it. An
    /// operator is not a reader (ADR 0079 §6), so the field that said
    /// otherwise is gone rather than corrected.
    ParticipantJoined {
        #[serde(serialize_with = "canonical")]
        principal_id: PrincipalId,
        mode: SessionMode,
    },
    /// Their last connection went away.
    ParticipantLeft { principal_id: PrincipalId },
    /// A grant was minted.
    ///
    /// No scope. The roster rule holds on the channel too: which rows a
    /// colleague can reach is the operator's business, and an event carrying
    /// it would hand a single-row participant a map of the vault. An operator
    /// who wants the scope reads the roster over HTTP, where the answer is
    /// shaped for them.
    GrantAdded {
        #[serde(serialize_with = "canonical")]
        grant_id: SessionGrantId,
        #[serde(serialize_with = "canonical")]
        subject_principal_id: PrincipalId,
        role: SessionRole,
        expires_at: DateTime<Utc>,
    },
    /// A grant was withdrawn, or lapsed.
    GrantWithdrawn {
        #[serde(serialize_with = "canonical")]
        grant_id: SessionGrantId,
        #[serde(serialize_with = "canonical")]
        subject_principal_id: PrincipalId,
    },
    /// Somebody opened an item. Sent only to participants who can reach it.
    ItemOpened {
        #[serde(serialize_with = "canonical")]
        vault_id: VaultId,
        #[serde(serialize_with = "canonical")]
        item_id: VaultItemId,
        #[serde(serialize_with = "canonical")]
        by_principal_id: PrincipalId,
    },
    /// Somebody wrote a new version of an item.
    ItemChanged {
        #[serde(serialize_with = "canonical")]
        vault_id: VaultId,
        #[serde(serialize_with = "canonical")]
        item_id: VaultItemId,
        #[serde(serialize_with = "canonical")]
        by_principal_id: PrincipalId,
    },
    /// A stranger asked to join.
    ///
    /// The id and nothing else — not the requester, and certainly not their
    /// note, which is untrusted text a person with no standing in the session
    /// typed. The operator fetches the request over HTTP, where it arrives
    /// with that framing attached. Text a human wrote never crosses this
    /// channel at all, which is a cheaper rule to hold than "escape it
    /// everywhere".
    JoinRequested { request_id: JoinRequestId },
    /// The operator ended the session.
    ///
    /// Every seat is given up and every grant the session minted is revoked at
    /// this instant; the reach it merely *referenced* is untouched and keeps
    /// working on its own road. The event is a courtesy — readers are cut off
    /// because the next standing read denies them, not because they were told.
    SessionClosed { closed_at: DateTime<Utc> },
}

/// Who an event is for, before per-recipient narrowing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience {
    /// Anybody with live standing in the session.
    Participants,
    /// Anybody with live standing who can reach this particular item.
    ReadersOf {
        vault_id: VaultId,
        item_id: VaultItemId,
    },
    /// The session's operator alone.
    OperatorOnly,
}

impl SessionEvent {
    /// The widest set this event may reach.
    ///
    /// Narrowing still happens per recipient in [`Delivery::for_recipient`];
    /// this is the shape of the question, not the answer.
    #[must_use]
    pub fn audience(&self) -> Audience {
        match self {
            Self::ParticipantJoined { .. }
            | Self::ParticipantLeft { .. }
            | Self::GrantAdded { .. }
            | Self::GrantWithdrawn { .. }
            | Self::SessionClosed { .. } => Audience::Participants,
            Self::ItemOpened {
                vault_id, item_id, ..
            }
            | Self::ItemChanged {
                vault_id, item_id, ..
            } => Audience::ReadersOf {
                vault_id: *vault_id,
                item_id: *item_id,
            },
            Self::JoinRequested { .. } => Audience::OperatorOnly,
        }
    }
}

/// One connected participant's standing, as the hub holds it.
///
/// Deliberately holds the *grants*, not a boolean: whether a given event
/// reaches this recipient depends on what they can reach, and a cached "yes"
/// is how a withdrawn grant keeps receiving.
#[derive(Clone, Debug)]
pub struct Recipient {
    pub principal_id: PrincipalId,
    pub is_operator: bool,
    /// The seat this reader holds, when they are not the operator.
    ///
    /// `None` is a reader with no seat, which is nobody: standing comes from a
    /// seat now, and a reader without one receives nothing at all.
    pub mode: Option<SessionMode>,
    pub grants: Vec<opensesame_domain::SessionGrant>,
}

/// The per-recipient send decision.
pub struct Delivery;

impl Delivery {
    /// Whether this recipient receives this event, right now.
    ///
    /// Asked once per recipient per event, against the recipient's live
    /// grants and the caller's clock. Deny by default: a recipient with no
    /// standing receives nothing, including their own departure.
    #[must_use]
    pub fn for_recipient(event: &SessionEvent, recipient: &Recipient, now: DateTime<Utc>) -> bool {
        // Standing is the seat, not the grants. An observer holds none and is
        // still in the room; somebody with neither is not, however many
        // expired grants still name them.
        let standing = recipient.is_operator || recipient.mode.is_some();
        if !standing {
            return false;
        }
        match event.audience() {
            Audience::Participants => true,
            Audience::OperatorOnly => recipient.is_operator,
            Audience::ReadersOf { vault_id, item_id } => {
                // Two refusals, and the first is the structural one: an
                // observer is never asked about, so a grant that somehow named
                // one could not deliver an item event to them.
                //
                // The operator is not exempt from the second. Running the
                // session is not reaching into the vault through it
                // (ADR 0079); an operator who granted themselves nothing sees
                // that somebody is working, not what they are working on.
                if recipient.mode == Some(SessionMode::Observer) {
                    return false;
                }
                crate::shared_session_fence::authorizing_grant(
                    &recipient.grants,
                    recipient.principal_id,
                    vault_id,
                    item_id,
                    SessionRole::Read,
                    now,
                )
                .is_some()
            }
        }
    }
}

/// How many events one session buffers for a reader that has fallen behind.
///
/// Small on purpose. A shared session is presence and small notices, not a
/// firehose; a reader that cannot keep up with sixty-four of them is a reader
/// whose connection is gone. Lagging is reported to that one reader and never
/// grows the buffer for anybody else — an unbounded channel here would let one
/// stalled browser tab hold every event in memory for the life of the session.
pub const SESSION_CHANNEL_CAPACITY: usize = 64;

/// One session's fan-out.
///
/// Holds no standing of its own. Every event still passes
/// [`Delivery::for_recipient`] against the reader's *live* grants before it
/// reaches a socket, so subscribing is not a permission and a subscription
/// that outlives its grant delivers nothing.
#[derive(Clone, Debug)]
pub struct SessionChannel {
    sender: tokio::sync::broadcast::Sender<SessionEvent>,
}

impl SessionChannel {
    #[must_use]
    pub fn new() -> Self {
        let (sender, _) = tokio::sync::broadcast::channel(SESSION_CHANNEL_CAPACITY);
        Self { sender }
    }

    /// Publish, best-effort. An event with nobody listening is dropped, which
    /// is correct: the store is the record, and the channel is a courtesy.
    pub fn publish(&self, event: SessionEvent) {
        let _ = self.sender.send(event);
    }

    #[must_use]
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<SessionEvent> {
        self.sender.subscribe()
    }

    /// Whether anybody is still listening.
    #[must_use]
    pub fn is_idle(&self) -> bool {
        self.sender.receiver_count() == 0
    }
}

impl Default for SessionChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "session_channel/tests.rs"]
mod tests;
