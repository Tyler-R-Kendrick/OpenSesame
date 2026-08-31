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
    JoinRequestId, PrincipalId, SessionGrantId, SessionRole, VaultId, VaultItemId,
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
    ParticipantJoined {
        #[serde(serialize_with = "canonical")]
        principal_id: PrincipalId,
        role: SessionRole,
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
            | Self::GrantWithdrawn { .. } => Audience::Participants,
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
        let standing = recipient.is_operator
            || recipient
                .grants
                .iter()
                .any(|grant| grant.assert_active(now).is_ok());
        if !standing {
            return false;
        }
        match event.audience() {
            Audience::Participants => true,
            Audience::OperatorOnly => recipient.is_operator,
            Audience::ReadersOf { vault_id, item_id } => {
                // The operator is not exempt here either. Running the session
                // is not reaching into the vault through it (ADR 0079); an
                // operator who granted themselves nothing sees that somebody
                // is working, not what they are working on.
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
mod tests {
    use super::*;
    use chrono::Duration;
    use opensesame_domain::{GrantScope, NewSessionGrant, SessionGrant, SessionId};
    use serde_json::Value;
    use std::collections::BTreeSet;

    fn grant(
        holder: PrincipalId,
        scope: GrantScope,
        lifetime: Duration,
        now: DateTime<Utc>,
    ) -> SessionGrant {
        SessionGrant::new(NewSessionGrant {
            id: SessionGrantId::new(),
            session_id: SessionId::new(),
            subject_principal_id: holder,
            granted_by_principal_id: PrincipalId::new(),
            scope,
            role: SessionRole::Read,
            granted_at: now,
            expires_at: now + lifetime,
        })
        .expect("a valid grant")
    }

    /// One of every variant, so the structural test cannot be passed by
    /// forgetting a case.
    fn every_variant() -> Vec<SessionEvent> {
        let now = Utc::now();
        vec![
            SessionEvent::ParticipantJoined {
                principal_id: PrincipalId::new(),
                role: SessionRole::Read,
            },
            SessionEvent::ParticipantLeft {
                principal_id: PrincipalId::new(),
            },
            SessionEvent::GrantAdded {
                grant_id: SessionGrantId::new(),
                subject_principal_id: PrincipalId::new(),
                role: SessionRole::Write,
                expires_at: now + Duration::hours(1),
            },
            SessionEvent::GrantWithdrawn {
                grant_id: SessionGrantId::new(),
                subject_principal_id: PrincipalId::new(),
            },
            SessionEvent::ItemOpened {
                vault_id: VaultId::new(),
                item_id: VaultItemId::new(),
                by_principal_id: PrincipalId::new(),
            },
            SessionEvent::ItemChanged {
                vault_id: VaultId::new(),
                item_id: VaultItemId::new(),
                by_principal_id: PrincipalId::new(),
            },
            SessionEvent::JoinRequested {
                request_id: JoinRequestId::new(),
            },
        ]
    }

    /// Whether a serialized string is something the channel is allowed to
    /// carry: an id, a closed discriminant, or a timestamp.
    fn is_reference(value: &str) -> bool {
        const DISCRIMINANTS: [&str; 11] = [
            "participant_joined",
            "participant_left",
            "grant_added",
            "grant_withdrawn",
            "item_opened",
            "item_changed",
            "join_requested",
            "read",
            "write",
            "private",
            "public",
        ];
        DISCRIMINANTS.contains(&value)
            || PrincipalId::parse(value).is_ok()
            || SessionGrantId::parse(value).is_ok()
            || JoinRequestId::parse(value).is_ok()
            || VaultId::parse(value).is_ok()
            || VaultItemId::parse(value).is_ok()
            || DateTime::parse_from_rfc3339(value).is_ok()
    }

    #[test]
    fn every_event_carries_references_and_never_prose() {
        // The structural fence. A variant that grew a label, a note, a title,
        // a token or any other free text fails here, because free text is not
        // an id and not a discriminant.
        for event in every_variant() {
            let json = serde_json::to_value(&event).unwrap();
            let fields: Vec<(String, Value)> = json
                .as_object()
                .expect("an object")
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            assert_field_is_a_reference(&event, &fields);
        }
    }

    /// Split out so the fence above stays one shallow loop.
    fn assert_field_is_a_reference(event: &SessionEvent, fields: &[(String, Value)]) {
        for (key, value) in fields {
            let text = value.as_str().unwrap_or_else(|| {
                panic!("{key} on {event:?} serialized as a non-string; audit it by hand")
            });
            assert!(
                is_reference(text),
                "{key} on {event:?} carried `{text}`, which is not a reference"
            );
        }
    }

    #[test]
    fn a_grant_event_never_names_the_scope_it_grants() {
        let vault_id = VaultId::new();
        let event = SessionEvent::GrantAdded {
            grant_id: SessionGrantId::new(),
            subject_principal_id: PrincipalId::new(),
            role: SessionRole::Read,
            expires_at: Utc::now(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains(&vault_id.to_string()));
        // And there is no field it could have gone in.
        assert!(!json.contains("scope"), "{json}");
        assert!(!json.contains("items"), "{json}");
    }

    #[test]
    fn a_join_request_event_carries_the_id_and_not_the_person_or_their_words() {
        let event = SessionEvent::JoinRequested {
            request_id: JoinRequestId::new(),
        };
        let json = serde_json::to_value(&event).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["request_id", "type"]);
    }

    #[test]
    fn a_join_request_reaches_the_operator_and_nobody_else() {
        let now = Utc::now();
        let event = SessionEvent::JoinRequested {
            request_id: JoinRequestId::new(),
        };
        let holder = PrincipalId::new();
        let participant = Recipient {
            principal_id: holder,
            is_operator: false,
            grants: vec![grant(
                holder,
                GrantScope::Collection {
                    vault_id: VaultId::new(),
                },
                Duration::hours(1),
                now,
            )],
        };
        let operator = Recipient {
            principal_id: PrincipalId::new(),
            is_operator: true,
            grants: Vec::new(),
        };
        assert!(!Delivery::for_recipient(&event, &participant, now));
        assert!(Delivery::for_recipient(&event, &operator, now));
    }

    #[test]
    fn an_item_event_reaches_only_participants_who_can_reach_that_item() {
        let now = Utc::now();
        let vault_id = VaultId::new();
        let mine = VaultItemId::new();
        let theirs = VaultItemId::new();
        let holder = PrincipalId::new();
        let row_scoped = Recipient {
            principal_id: holder,
            is_operator: false,
            grants: vec![grant(
                holder,
                GrantScope::Rows {
                    vault_id,
                    items: [mine].into_iter().collect::<BTreeSet<_>>(),
                },
                Duration::hours(1),
                now,
            )],
        };

        let reachable = SessionEvent::ItemOpened {
            vault_id,
            item_id: mine,
            by_principal_id: PrincipalId::new(),
        };
        let out_of_reach = SessionEvent::ItemOpened {
            vault_id,
            item_id: theirs,
            by_principal_id: PrincipalId::new(),
        };
        assert!(Delivery::for_recipient(&reachable, &row_scoped, now));
        assert!(
            !Delivery::for_recipient(&out_of_reach, &row_scoped, now),
            "a row-scoped participant was told about an item they cannot reach"
        );
    }

    #[test]
    fn running_the_session_is_not_reaching_into_the_vault_through_it() {
        // An operator who granted themselves nothing sees that somebody is
        // working, not what they are working on. Conflating the two is how
        // "manages the sharing" becomes "reads everything shared".
        let now = Utc::now();
        let operator = Recipient {
            principal_id: PrincipalId::new(),
            is_operator: true,
            grants: Vec::new(),
        };
        let joined = SessionEvent::ParticipantJoined {
            principal_id: PrincipalId::new(),
            role: SessionRole::Read,
        };
        let opened = SessionEvent::ItemOpened {
            vault_id: VaultId::new(),
            item_id: VaultItemId::new(),
            by_principal_id: PrincipalId::new(),
        };
        assert!(Delivery::for_recipient(&joined, &operator, now));
        assert!(!Delivery::for_recipient(&opened, &operator, now));
    }

    #[test]
    fn a_lapsed_participant_receives_nothing_at_all() {
        // The send-time re-check. A grant that expired between the event and
        // the send stops delivery on this event, not at the next reconnect.
        let now = Utc::now();
        let holder = PrincipalId::new();
        let vault_id = VaultId::new();
        let recipient = Recipient {
            principal_id: holder,
            is_operator: false,
            grants: vec![grant(
                holder,
                GrantScope::Collection { vault_id },
                Duration::minutes(1),
                now,
            )],
        };
        let event = SessionEvent::ParticipantJoined {
            principal_id: PrincipalId::new(),
            role: SessionRole::Read,
        };
        assert!(Delivery::for_recipient(&event, &recipient, now));
        assert!(
            !Delivery::for_recipient(&event, &recipient, now + Duration::minutes(2)),
            "a participant whose grant lapsed was still on the channel"
        );
    }

    #[test]
    fn a_recipient_with_no_standing_receives_nothing() {
        let now = Utc::now();
        let stranger = Recipient {
            principal_id: PrincipalId::new(),
            is_operator: false,
            grants: Vec::new(),
        };
        for event in every_variant() {
            assert!(
                !Delivery::for_recipient(&event, &stranger, now),
                "a stranger received {event:?}"
            );
        }
    }
}
