//! Security oracles shared by every harness.

use opensesame_domain::{CapabilitySet, Grant};
use serde_json::Value;

const SECRET_KEY_NEEDLES: &[&str] = &[
    "password",
    "secret",
    "token",
    "authorization",
    "refresh_token",
    "access_token",
    "client_secret",
    "private_key",
    "device_code",
    "claim_token",
    "cookie",
    "set-cookie",
];

pub fn assert_intersection_subset(a: &CapabilitySet, b: &CapabilitySet, inter: &CapabilitySet) {
    assert!(
        inter.is_subset_of(a),
        "intersection must be a subset of the left input"
    );
    assert!(
        inter.is_subset_of(b),
        "intersection must be a subset of the right input"
    );
}

pub fn assert_attenuation_did_not_widen(parent: &Grant, child: &Grant) {
    assert_eq!(
        child.organization_id, parent.organization_id,
        "child must stay in the parent organization"
    );
    assert!(
        child
            .actions
            .iter()
            .all(|a| parent.actions.iter().any(|p| p == a)),
        "child actions must be a subset of parent actions"
    );
    assert!(
        child
            .resources
            .iter()
            .all(|r| parent.resources.iter().any(|p| p == r)),
        "child resources must be a subset of parent resources"
    );
    assert!(
        child
            .constraints
            .audiences
            .iter()
            .all(|a| parent.constraints.audiences.iter().any(|p| p == a)),
        "child audiences must be a subset of parent audiences"
    );
    assert!(
        child.constraints.expires_at <= parent.constraints.expires_at,
        "child lifetime must not expand"
    );
    assert!(
        child.constraints.maximum_delegation_depth <= parent.constraints.maximum_delegation_depth,
        "child max depth must not expand"
    );
    assert!(
        !child.constraints.raw_credential_export || parent.constraints.raw_credential_export,
        "export privilege must not expand"
    );
    for (k, v) in &child.constraints.budgets {
        match parent.constraints.budgets.get(k) {
            Some(pv) if v <= pv => {}
            _ => panic!("budget {k} expanded or was not in the parent"),
        }
    }
}

pub fn assert_bindings_preserved(original: &Grant, decoded: &Grant) {
    assert_eq!(original.organization_id, decoded.organization_id);
    assert_eq!(
        original.issuer_principal_id,
        decoded.issuer_principal_id
    );
    assert_eq!(
        original.beneficiary_principal_id,
        decoded.beneficiary_principal_id
    );
    assert_eq!(original.actions, decoded.actions);
    assert_eq!(original.resources, decoded.resources);
    assert_eq!(original.constraints.audiences, decoded.constraints.audiences);
    assert_eq!(original.revoked_at, decoded.revoked_at);
}

pub fn assert_roundtrip_caps(set: &CapabilitySet) {
    let bytes = serde_json::to_vec(set).expect("encode CapabilitySet");
    let back: CapabilitySet = serde_json::from_slice(&bytes).expect("decode CapabilitySet");
    assert_eq!(set.canonicalize(), back.canonicalize());
    if let (Ok(a), Ok(b)) = (set.digest(), back.digest()) {
        assert_eq!(a, b);
    }
}

pub fn assert_no_secret_fields(value: &Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if is_secret_key(k) {
                    assert_eq!(
                        v,
                        &Value::String("[REDACTED]".into()),
                        "secret field {k} must be redacted"
                    );
                } else {
                    assert_no_secret_fields(v);
                }
            }
        }
        Value::Array(arr) => {
            for v in arr {
                assert_no_secret_fields(v);
            }
        }
        _ => {}
    }
}

pub fn assert_redacted_text_hides(original: &str, redacted: &str) {
    let lower = original.to_ascii_lowercase();
    let has_authorization_value = ["bearer ", "basic "].iter().any(|scheme| {
        lower
            .match_indices(scheme)
            .any(|(index, found)| !lower[index + found.len()..].trim_start().is_empty())
    });
    if has_authorization_value {
        assert!(
            redacted.contains("[REDACTED]"),
            "authorization schemes must redact: original={original:?} redacted={redacted:?}"
        );
    }
}

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_KEY_NEEDLES.iter().any(|n| lower.contains(n))
}
