//! What the channel may carry, and who each thing reaches (ADR 0079 §2).

use super::*;
use chrono::Duration;
use opensesame_domain::{GrantLink, GrantScope, NewSessionGrant, SessionGrant, SessionId};
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
        link: GrantLink::LifecycleBound,
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
            mode: SessionMode::Observer,
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
        SessionEvent::SessionClosed {
            closed_at: now + Duration::hours(2),
        },
    ]
}

/// Whether a serialized string is something the channel is allowed to
/// carry: an id, a closed discriminant, or a timestamp.
fn is_reference(value: &str) -> bool {
    const DISCRIMINANTS: [&str; 15] = [
        "participant_joined",
        "participant_left",
        "grant_added",
        "grant_withdrawn",
        "item_opened",
        "item_changed",
        "join_requested",
        "session_closed",
        "read",
        "write",
        "observer",
        "participant",
        "lifecycle_bound",
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
        mode: Some(SessionMode::Participant),
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
        mode: None,
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
        mode: Some(SessionMode::Participant),
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
        mode: None,
        grants: Vec::new(),
    };
    let joined = SessionEvent::ParticipantJoined {
        principal_id: PrincipalId::new(),
        mode: SessionMode::Participant,
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
fn a_lapsed_grant_stops_the_item_events_and_leaves_the_person_in_the_room() {
    // The send-time re-check, restated for coordination sessions. Presence and
    // reach are separate now: somebody whose grant expired mid-stream keeps
    // their seat, because they are still in the meeting, and stops receiving
    // anything that names an item, because they can no longer open one. The
    // old rule cut them off the channel entirely, which conflated the two.
    let now = Utc::now();
    let holder = PrincipalId::new();
    let vault_id = VaultId::new();
    let recipient = Recipient {
        principal_id: holder,
        is_operator: false,
        mode: Some(SessionMode::Participant),
        grants: vec![grant(
            holder,
            GrantScope::Collection { vault_id },
            Duration::minutes(1),
            now,
        )],
    };
    let presence = SessionEvent::ParticipantJoined {
        principal_id: PrincipalId::new(),
        mode: SessionMode::Participant,
    };
    let opened = SessionEvent::ItemOpened {
        vault_id,
        item_id: VaultItemId::new(),
        by_principal_id: PrincipalId::new(),
    };
    let later = now + Duration::minutes(2);

    assert!(Delivery::for_recipient(&presence, &recipient, now));
    assert!(Delivery::for_recipient(&opened, &recipient, now));
    assert!(
        Delivery::for_recipient(&presence, &recipient, later),
        "somebody was thrown out of the room because their grant lapsed"
    );
    assert!(
        !Delivery::for_recipient(&opened, &recipient, later),
        "a participant whose grant lapsed was still told what was opened"
    );
}

#[test]
fn an_observer_is_in_the_room_and_never_hears_about_an_item() {
    // The coordination case end to end. An observer holds no grants at all, so
    // the item branch would deny them anyway; the seat check denies them
    // before the grants are consulted, which is what still holds if a grant
    // ever names one.
    let now = Utc::now();
    let holder = PrincipalId::new();
    let vault_id = VaultId::new();
    let observer = Recipient {
        principal_id: holder,
        is_operator: false,
        mode: Some(SessionMode::Observer),
        grants: Vec::new(),
    };
    // Belt and braces: the same seat, holding a grant it should never have
    // been given. The delivery answer must not change.
    let contradiction = Recipient {
        grants: vec![grant(
            holder,
            GrantScope::Collection { vault_id },
            Duration::hours(1),
            now,
        )],
        ..observer.clone()
    };

    let presence = SessionEvent::ParticipantJoined {
        principal_id: PrincipalId::new(),
        mode: SessionMode::Observer,
    };
    let opened = SessionEvent::ItemOpened {
        vault_id,
        item_id: VaultItemId::new(),
        by_principal_id: PrincipalId::new(),
    };
    let closed = SessionEvent::SessionClosed { closed_at: now };

    assert!(Delivery::for_recipient(&presence, &observer, now));
    assert!(Delivery::for_recipient(&closed, &observer, now));
    assert!(
        !Delivery::for_recipient(&opened, &observer, now),
        "an observer was told which item somebody opened"
    );
    assert!(
        !Delivery::for_recipient(&opened, &contradiction, now),
        "a grant that named an observer delivered an item event to them"
    );
}

#[test]
fn a_presence_event_announces_a_seat_and_never_a_role() {
    // The operator used to be announced as `write`, which said the person
    // running the session writes the vault through it. There is no field left
    // that could say so.
    let json = serde_json::to_value(SessionEvent::ParticipantJoined {
        principal_id: PrincipalId::new(),
        mode: SessionMode::Observer,
    })
    .unwrap();
    let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["mode", "principal_id", "type"]);
}

#[test]
fn a_recipient_with_no_standing_receives_nothing() {
    let now = Utc::now();
    let stranger = Recipient {
        principal_id: PrincipalId::new(),
        is_operator: false,
        mode: None,
        grants: Vec::new(),
    };
    for event in every_variant() {
        assert!(
            !Delivery::for_recipient(&event, &stranger, now),
            "a stranger received {event:?}"
        );
    }
}
