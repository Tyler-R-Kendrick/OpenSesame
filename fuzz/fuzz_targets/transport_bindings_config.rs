#![no_main]

//! Transport configuration parsing (ADR 0130).
//!
//! `ServiceBindingSet::parse_json` is the only door by which a binding
//! document — a file in the deployment plane, a stored `host_kv` value or an
//! operator `PUT` body — becomes authority. Anything it accepts must be
//! fully valid, because admission never re-checks structure; and the
//! refusal must never echo the document, which carries operator topology.

use libfuzzer_sys::fuzz_target;
use opensesame_domain::transport::{ServiceBindingSet, TransportError};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    match ServiceBindingSet::parse_json(text) {
        Ok(set) => {
            set.validate()
                .expect("a parsed binding set must already be valid");
            assert!(set.revision > 0);
            let mut ids: Vec<&str> = set.bindings.iter().map(|b| b.id.as_str()).collect();
            ids.sort_unstable();
            let before = ids.len();
            ids.dedup();
            assert_eq!(ids.len(), before, "duplicate binding ids were accepted");
            for binding in &set.bindings {
                binding.peer.validate().expect("selector");
                assert!(!binding.allowed_operations.is_empty());
            }
        }
        Err(TransportError::MalformedConfiguration(detail)) => {
            assert!(detail.len() < 4096, "unbounded refusal detail");
        }
        Err(other) => panic!("unexpected error kind: {other:?}"),
    }
});
