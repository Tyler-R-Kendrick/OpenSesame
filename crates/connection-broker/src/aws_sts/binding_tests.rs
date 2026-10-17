//! What a binding accepts, and what of it ever leaves the broker.

use super::*;

fn input() -> AwsStsBindingInput {
    AwsStsBindingInput {
        role_arn: "arn:aws:iam::123456789012:role/deploy/Deployer".into(),
        region: "us-east-1".into(),
        max_duration_seconds: Some(1800),
        session_policy: Some(serde_json::json!({
            "Version": "2012-10-17",
            "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}]
        })),
        external_id: Some("vtok_dummy_marker_0123456789abcdef".into()),
    }
}

#[test]
fn a_valid_binding_is_accepted_and_its_view_is_value_blind() {
    let binding = AwsStsBinding::from_input(input()).unwrap();
    assert_eq!(binding.max_duration_seconds, 1800);
    let policy = binding.session_policy.as_deref().unwrap();
    assert!(
        policy.contains("s3:GetObject") && !policy.contains(' '),
        "{policy}"
    );
    let view = binding.view();
    assert!(view.external_id && view.session_policy);
    let shown = format!("{binding:?} {view:?} {:?}", input());
    assert!(!shown.contains("vtok_dummy_marker"), "{shown}");
    let wire = serde_json::to_string(&view).unwrap();
    assert!(!wire.contains("vtok_dummy_marker"), "{wire}");
}

#[test]
fn the_sealed_form_round_trips_the_external_id() {
    let binding = AwsStsBinding::from_input(input()).unwrap();
    let plaintext = serde_json::to_vec(&binding).unwrap();
    let back: AwsStsBinding = serde_json::from_slice(&plaintext).unwrap();
    assert_eq!(
        back.external_id
            .as_ref()
            .map(|id| id.expose_secret().to_string()),
        Some("vtok_dummy_marker_0123456789abcdef".to_string())
    );
}

/// One way to spoil an input, by name.
type Spoil = (&'static str, Box<dyn Fn(&mut AwsStsBindingInput)>);

#[test]
fn every_field_outside_its_bounds_is_refused() {
    let cases: Vec<Spoil> = vec![
        ("not an arn", Box::new(|i| i.role_arn = "Deployer".into())),
        (
            "user arn",
            Box::new(|i| i.role_arn = "arn:aws:iam::123456789012:user/x".into()),
        ),
        (
            "short account",
            Box::new(|i| i.role_arn = "arn:aws:iam::1234:role/x".into()),
        ),
        (
            "odd partition",
            Box::new(|i| i.role_arn = "arn:evil:iam::123456789012:role/x".into()),
        ),
        ("region", Box::new(|i| i.region = "moon-1".into())),
        ("cap low", Box::new(|i| i.max_duration_seconds = Some(899))),
        (
            "cap high",
            Box::new(|i| i.max_duration_seconds = Some(3601)),
        ),
        (
            "policy shape",
            Box::new(|i| i.session_policy = Some(serde_json::json!(["x"]))),
        ),
        (
            "policy fields",
            Box::new(|i| i.session_policy = Some(serde_json::json!({"Version": "2012-10-17"}))),
        ),
        (
            "policy size",
            Box::new(|i| {
                i.session_policy = Some(serde_json::json!({
                    "Version": "2012-10-17", "Statement": "x".repeat(2100)
                }));
            }),
        ),
        (
            "external id",
            Box::new(|i| i.external_id = Some("has space".into())),
        ),
    ];
    for (name, mutate) in cases {
        let mut candidate = input();
        mutate(&mut candidate);
        assert!(AwsStsBinding::from_input(candidate).is_err(), "{name}");
    }
}

#[test]
fn the_cap_defaults_to_the_minimum() {
    let mut candidate = input();
    candidate.max_duration_seconds = None;
    candidate.session_policy = None;
    candidate.external_id = None;
    let binding = AwsStsBinding::from_input(candidate).unwrap();
    assert_eq!(binding.max_duration_seconds, 900);
    assert!(!binding.view().external_id);
}
