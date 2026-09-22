use super::binding_tests::{binding, spiffe, Mutation, HEX_A};
use super::*;
use serde_json::json;

fn bridge() -> PeerIdentitySelector {
    spiffe("ns/prod/sa/nats-bridge")
}

#[test]
fn validate_rejects_structural_faults() {
    let good = binding("b1", bridge(), BindingPurpose::NatsAuthBridge);
    let cases: Vec<(&str, Mutation<ServiceBinding>)> = vec![
        ("empty id", Box::new(|b| b.id = String::new())),
        ("long id", Box::new(|b| b.id = "x".repeat(129))),
        ("space id", Box::new(|b| b.id = "a b".into())),
        ("revision 0", Box::new(|b| b.revision = 0)),
        (
            "bad org id",
            Box::new(|b| {
                b.scope = BindingScope::Organization {
                    organization_id: String::new(),
                }
            }),
        ),
        (
            "bad profile",
            Box::new(|b| {
                b.trust_profile = TrustProfileRef {
                    name: "Upper".into(),
                }
            }),
        ),
        (
            "bad peer",
            Box::new(|b| b.peer = PeerIdentitySelector::DnsName("*.example".into())),
        ),
        (
            "empty principal",
            Box::new(|b| b.service_principal = String::new()),
        ),
        ("no ops", Box::new(|b| b.allowed_operations = vec![])),
        (
            "empty op",
            Box::new(|b| b.allowed_operations = vec![String::new()]),
        ),
        (
            "dup op",
            Box::new(|b| b.allowed_operations = vec!["a.b".into(), "a.b".into()]),
        ),
        (
            "bad audience",
            Box::new(|b| b.allowed_audiences = vec!["has space".into()]),
        ),
        (
            "bad thumbprint",
            Box::new(|b| b.denied_thumbprints = vec![HEX_A.to_ascii_uppercase()]),
        ),
        (
            "dup thumbprint",
            Box::new(|b| b.denied_thumbprints = vec![HEX_A.into(), HEX_A.into()]),
        ),
        (
            "too many ops",
            Box::new(|b| {
                b.allowed_operations = (0..=MAX_LIST_ENTRIES).map(|i| format!("op.{i}")).collect();
            }),
        ),
    ];
    for (why, mutate) in cases {
        let mut b = good.clone();
        mutate(&mut b);
        assert_eq!(
            b.validate().unwrap_err().code(),
            "malformed_configuration",
            "{why}"
        );
        let set = ServiceBindingSet {
            revision: 1,
            bindings: vec![b],
        };
        assert!(set.validate().is_err(), "{why} via set");
    }
    assert!(good.validate().is_ok());
    let dup = ServiceBindingSet {
        revision: 1,
        bindings: vec![good.clone(), good.clone()],
    };
    assert!(dup
        .validate()
        .unwrap_err()
        .to_string()
        .contains("duplicate id"));
    assert!(ServiceBindingSet {
        revision: 0,
        bindings: vec![]
    }
    .validate()
    .is_err());
    let huge = ServiceBindingSet {
        revision: 1,
        bindings: (0..=MAX_BINDINGS)
            .map(|i| binding(&format!("b{i}"), bridge(), BindingPurpose::NatsAuthBridge))
            .collect(),
    };
    assert!(huge.validate().is_err());
}

#[test]
fn parse_json_refuses_unknown_fields_and_coercion() {
    let base = json!({
        "revision": 1,
        "bindings": [{
            "id": "b1", "revision": 1, "enabled": true, "revoked": false,
            "scope": "deployment", "trust_profile": { "name": "private-root" },
            "peer": { "spiffe_id": "spiffe://example.org/ns/prod/sa/nats-bridge" },
            "service_principal": "svc:bridge", "purpose": "nats_auth_bridge",
            "allowed_operations": ["nats.callout.decide"], "allowed_audiences": ["host"],
            "denied_thumbprints": []
        }]
    });
    let parsed = ServiceBindingSet::parse_json(&base.to_string()).unwrap();
    assert_eq!(parsed.bindings[0].not_after, None);
    let mutations: Vec<(&str, serde_json::Value)> = vec![
        ("/bindings/0/enabled", json!("true")),
        ("/bindings/0/enabled", json!(1)),
        ("/bindings/0/revision", json!("1")),
        ("/bindings/0/revision", json!(1.5)),
        ("/bindings/0/revision", json!(-1)),
        ("/bindings/0/purpose", json!("admin")),
        ("/bindings/0/scope", json!("organization")),
        (
            "/bindings/0/scope",
            json!({ "organization": { "organization_id": "o", "extra": 1 } }),
        ),
        ("/bindings/0/not_after", json!("2026-09-22T10:00:00")),
        ("/bindings/0/not_after", json!(1_758_535_200)),
        ("/bindings/0/trust_profile", json!("private-root")),
        ("/bindings/0/peer", json!({ "dns_name": "Bridge" })),
        (
            "/bindings/0/allowed_operations",
            json!("nats.callout.decide"),
        ),
        ("/bindings/0/role", json!("admin")),
        ("/bindings/0/verified", json!(true)),
        ("/extra", json!(1)),
    ];
    for (pointer, value) in mutations {
        let mut doc = base.clone();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        doc.pointer_mut(parent).unwrap()[key] = value.clone();
        let err = ServiceBindingSet::parse_json(&doc.to_string()).unwrap_err();
        assert_eq!(err.code(), "malformed_configuration", "{pointer}={value}");
    }
    assert!(ServiceBindingSet::parse_json("not json").is_err());
    assert!(ServiceBindingSet::parse_json("[]").is_err());
}
