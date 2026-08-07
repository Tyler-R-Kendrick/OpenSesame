use super::adapter::*;
use crate::error::AAuthError;
use opensesame_domain::{Capability, CapabilitySet, ResourceSelector};

#[test]
fn one_person_maps_to_one_principal() {
    let person = Person {
        id: "person-alice".into(),
        display_name: Some("Alice".into()),
    };
    let a = map_person(&person);
    let b = map_person(&person);
    assert_eq!(a, b);
    assert_eq!(unmap_person(&a).id, person.id);

    let mapped = assert_one_person(&[person]).unwrap();
    assert_eq!(mapped.source_person_id, "person-alice");
}

#[test]
fn multiple_persons_rejected() {
    let p1 = Person {
        id: "p1".into(),
        display_name: None,
    };
    let p2 = Person {
        id: "p2".into(),
        display_name: None,
    };
    assert_eq!(
        assert_one_person(&[p1, p2]),
        Err(AAuthError::MultiplePersons)
    );
}

#[test]
fn mission_byte_mutation_changes_digest() {
    let m1 = Mission {
        bytes: b"mission-v1".to_vec(),
    };
    let m2 = Mission {
        bytes: b"mission-v2".to_vec(),
    };
    let ctx1 = mission_to_governance_context(&m1);
    let ctx2 = mission_to_governance_context(&m2);
    assert_ne!(ctx1.mission_digest, ctx2.mission_digest);
    assert_eq!(ctx1.mission_bytes_len, m1.bytes.len());
}

#[test]
fn scope_outside_ceiling_rejected() {
    let ceiling = CapabilitySet::new(vec![Capability::new("read", ResourceSelector::exact("*"))])
        .canonicalize();
    assert!(assert_scopes_within_ceiling(&["read"], &ceiling).is_ok());
    assert_eq!(
        assert_scopes_within_ceiling(&["write"], &ceiling),
        Err(AAuthError::ScopeOutsideCeiling)
    );
}

#[test]
fn protocol_token_ref_identity() {
    let a = ProtocolTokenRef {
        issuer: "https://issuer.example".into(),
        jti: "jti-123".into(),
    };
    let b = a.clone();
    assert_eq!(a, b);
}

#[test]
fn agent_maps_to_actor_and_instance() {
    let agent = Agent {
        id: "agent-1".into(),
        instance_id: "inst-9".into(),
    };
    let mapped = map_agent(&agent);
    assert_eq!(mapped.source_agent_id, agent.id);
    assert_eq!(mapped.source_instance_id, agent.instance_id);
}
