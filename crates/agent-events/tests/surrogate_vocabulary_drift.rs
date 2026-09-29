//! The `surrogate.*` names on the feed are exactly the names the broker emits.
//!
//! Invoke-through's `RefusalCode::as_str` is the other half of this
//! vocabulary, and the feed deliberately does not depend on the broker to read
//! it (the feed's crates stay value-blind and free of the broker's tree). So
//! the broker's source is read as text instead, the way the gateway pins the
//! rotation broker's: every `"surrogate.…"` literal in the refusal module must
//! be a name this crate publishes, and every name this crate publishes must be
//! one the broker can emit. A code added on one side only fails here, before
//! the adapter can hand the feed a name it refuses — or advertise one nothing
//! ever sends.

use std::collections::BTreeSet;

use opensesame_agent_events::SURROGATE_EVENT_TYPES;

const BROKER_REFUSALS: &str = include_str!("../../invoke-through/src/surrogate/refusal.rs");

fn broker_names() -> BTreeSet<&'static str> {
    BROKER_REFUSALS
        .split('"')
        .skip(1)
        .step_by(2)
        .filter(|literal| literal.starts_with("surrogate."))
        .collect()
}

#[test]
fn the_feed_and_the_broker_name_the_same_refusals() {
    let feed: BTreeSet<&str> = SURROGATE_EVENT_TYPES.iter().copied().collect();
    assert_eq!(
        feed.len(),
        SURROGATE_EVENT_TYPES.len(),
        "a name is listed twice"
    );
    assert_eq!(broker_names(), feed);
}
