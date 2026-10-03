//! The hook filter's vocabulary: one union of every family's frozen names,
//! the same for discovery and for registration.

use super::{is_known_subject_kind, known_event_types};
use opensesame_agent_events::{
    AGENT_EVENT_TYPES, EVENT_RUN_BLOCKED, SURROGATE_EVENT_TYPES, SURROGATE_SUBJECT_KINDS,
};
use opensesame_breach_intel::BREACH_EVENT_TYPES;
use opensesame_lifecycle::{EVENT_RENEWAL_DUE, LIFECYCLE_EVENT_TYPES};
use opensesame_security_events::filter;

fn entries(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_string()).collect()
}

fn valid(names: &[&str]) -> bool {
    filter::is_valid(&entries(names), &known_event_types())
}

#[test]
fn one_subscription_may_span_every_family() {
    assert!(valid(&[EVENT_RENEWAL_DUE, EVENT_RUN_BLOCKED]));
    assert!(valid(&[
        "lifecycle.*",
        "breach.*",
        "agent.*",
        "surrogate.*"
    ]));
    assert!(valid(&["*"]));
}

#[test]
fn an_unknown_name_is_refused_even_beside_valid_ones() {
    assert!(!valid(&[EVENT_RENEWAL_DUE, "agent.run.exploded"]));
    assert!(!valid(&["everything"]));
    assert!(!valid(&["rumour.*"]));
}

#[test]
fn an_empty_filter_is_refused_rather_than_read_as_everything() {
    assert!(!valid(&[]));
}

#[test]
fn discovery_and_registration_answer_for_the_same_families() {
    // One union, used by both surfaces. Two lists is how a caller reads
    // the advertised vocabulary, registers from it, and is told a name it
    // was just given is unknown — or, worse, never learns a family exists.
    let advertised = known_event_types();
    for name in LIFECYCLE_EVENT_TYPES
        .iter()
        .chain(BREACH_EVENT_TYPES.iter())
        .chain(AGENT_EVENT_TYPES.iter())
        .chain(SURROGATE_EVENT_TYPES.iter())
    {
        assert!(advertised.contains(name), "{name} is not discoverable");
        assert!(valid(&[name]), "{name} is advertised but not registrable");
    }
    assert_eq!(
        advertised.len(),
        LIFECYCLE_EVENT_TYPES.len()
            + BREACH_EVENT_TYPES.len()
            + AGENT_EVENT_TYPES.len()
            + SURROGATE_EVENT_TYPES.len(),
        "the union carries every family and nothing else",
    );
}

#[test]
fn a_surrogate_tripwire_is_registrable_by_name_and_by_subject() {
    // ADR 0150 §5: the family is only a tripwire if someone can subscribe to
    // it — by exact name, by `surrogate.*`, and narrowed to the run or the
    // broker it reports under.
    assert!(valid(&["surrogate.misdirected"]));
    assert!(valid(&["surrogate.*"]));
    for kind in SURROGATE_SUBJECT_KINDS {
        assert!(is_known_subject_kind(kind), "{kind} is not registrable");
    }
}
