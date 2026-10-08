mod observation_vector {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../human-vault/tests/support/credential_observation_vector.rs"
    ));
}
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;

const NOW: &str = "2026-10-06T12:00:00.000Z";
#[derive(Deserialize)]
struct Vector {
    context: ArtifactContext,
    #[serde(rename = "presentedId")]
    presented_id: String,
    #[serde(rename = "digestB64")]
    digest_b64: String,
}
#[derive(Deserialize)]
struct Vectors {
    vectors: Vec<Vector>,
}

#[test]
fn published_typescript_vectors_and_reserved_reference_spellings_match() {
    let vectors: Vectors = serde_json::from_str(include_str!(
        "../../../../packages/app-core/src/lib/credential-canaries/protocol-vectors.json"
    ))
    .unwrap();
    assert_eq!(vectors.vectors.len(), 4);
    for vector in vectors.vectors {
        assert_eq!(
            STANDARD.encode(digest(&vector.context, &vector.presented_id).unwrap()),
            vector.digest_b64
        );
        assert_eq!(
            encode_presented_id(&decode_presented_id(&vector.presented_id).unwrap()),
            vector.presented_id
        );
        let encoded = reference(&vector.presented_id).unwrap();
        assert_eq!(
            parse_reference(&encoded).unwrap(),
            Some(vector.presented_id.as_str())
        );
    }
    assert!(parse_reference("normal-production-reference")
        .unwrap()
        .is_none());
    for value in [
        "oscanary:v1:",
        "oscanary:v1:abc",
        "oscanary:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    ] {
        assert!(parse_reference(value).is_err());
    }
}

#[test]
fn recognition_never_recovers_production_authority_and_keeps_closed_metadata() {
    let mut registry = Registry::new("owner", "stable-vault");
    let artifact = registry
        .create(ArtifactKind::McpConfiguration, NOW)
        .unwrap();
    let wire = registry.encode().unwrap();
    assert!(!wire.contains(&artifact.presented_id));
    assert!(Registry::parse(&wire, "owner", "different-vault").is_err());
    let observed = registry
        .observe_bound(&artifact.id, &artifact.presented_id, Phase::Connected, NOW)
        .unwrap();
    assert!(matches!(observed.decision, Decision::Canary { .. }));
    assert!(observed.event.is_some());
    assert!(registry
        .observe_bound(&artifact.id, &artifact.presented_id, Phase::Connected, NOW)
        .unwrap()
        .event
        .is_none());
    let wrong = mint_presented_id();
    assert_eq!(
        registry
            .observe_bound(&artifact.id, &wrong, Phase::Invoked, NOW)
            .unwrap()
            .decision,
        Decision::Unrecognized
    );
    assert!(registry
        .observe_bound(
            &artifact.id,
            &artifact.presented_id,
            Phase::RetiredGenerationObserved,
            NOW
        )
        .is_err());
    assert_eq!(registry.events.len(), 1);
    let exported = serde_json::to_value(&registry.events[0]).unwrap();
    assert_eq!(exported.as_object().unwrap().len(), 8);
    assert!(exported.get("credential").is_none());
    assert!(exported.get("arguments").is_none());
}

#[test]
fn metadata_caps_suppress_evidence_without_disabling_canary_classification() {
    let mut registry = Registry::new("owner", "stable-vault");
    let artifacts: Vec<_> = (0..super::MAX_ARTIFACTS)
        .map(|_| registry.create(ArtifactKind::ConnectionRef, NOW).unwrap())
        .collect();
    assert!(registry.create(ArtifactKind::ConnectionRef, NOW).is_err());
    for minute in 0..8 {
        let at = format!("2026-10-06T12:{minute:02}:00.000Z");
        assert!(registry
            .observe_bound(
                &artifacts[0].id,
                &artifacts[0].presented_id,
                Phase::Invoked,
                &at
            )
            .unwrap()
            .event
            .is_some());
    }
    let capped = registry
        .observe_bound(
            &artifacts[0].id,
            &artifacts[0].presented_id,
            Phase::Invoked,
            "2026-10-06T12:10:00.000Z",
        )
        .unwrap();
    assert!(matches!(capped.decision, Decision::Canary { .. }));
    assert!(capped.event.is_none());
    for artifact in &artifacts[1..8] {
        for minute in 0..8 {
            let at = format!("2026-10-06T12:{minute:02}:00.000Z");
            registry
                .observe_bound(&artifact.id, &artifact.presented_id, Phase::Invoked, &at)
                .unwrap();
        }
    }
    assert_eq!(registry.events.len(), 64);
    let full = registry
        .observe_bound(
            &artifacts[8].id,
            &artifacts[8].presented_id,
            Phase::Invoked,
            NOW,
        )
        .unwrap();
    assert!(matches!(full.decision, Decision::Canary { .. }));
    assert!(full.event.is_none());
    assert_eq!(registry.events.len(), 64);
    let restored = Registry::parse(&registry.encode().unwrap(), "owner", "stable-vault").unwrap();
    assert_eq!(restored.events.len(), 64);
}

#[test]
fn verified_generation_retirement_matches_only_its_exact_registered_identity() {
    let mut registry = Registry::new("owner", "stable-vault");
    let raw = mint_presented_id();
    let context = ArtifactContext {
        vault_identity: "stable-vault".into(),
        kind: ArtifactKind::AgentLease,
        generation: 7,
    };
    let retired = registry
        .register_verified_retired(&context, &raw, NOW)
        .unwrap();
    assert_eq!(retired.state, ArtifactState::Retired);
    assert!(registry
        .register_verified_retired(&context, &raw, NOW)
        .is_err());
    let observation = registry
        .observe_bound(&retired.id, &raw, Phase::RetiredGenerationObserved, NOW)
        .unwrap();
    assert!(matches!(observation.decision, Decision::Canary { .. }));
    assert_eq!(observation.event.unwrap().generation, 7);
    let mut foreign = context;
    foreign.vault_identity = "different-vault".into();
    assert!(registry
        .register_verified_retired(&foreign, &mint_presented_id(), NOW)
        .is_err());
}

#[test]
fn copied_corrupt_and_unbounded_state_fails_closed_before_matching() {
    let mut registry = Registry::new("owner", "stable-vault");
    registry.create(ArtifactKind::ConnectionRef, NOW).unwrap();
    let valid = serde_json::to_value(&registry).unwrap();
    for field in ["v", "tomb", "vaultIdentity"] {
        let mut changed = valid.clone();
        changed[field] = serde_json::json!("incorrect");
        assert!(Registry::parse(&changed.to_string(), "owner", "stable-vault").is_err());
    }
    let mut duplicate = registry.clone();
    duplicate.artifacts.push(duplicate.artifacts[0].clone());
    assert!(duplicate.validate("owner", "stable-vault").is_err());
    let mut mismatched = registry;
    mismatched.artifacts[0].retired_at = Some(NOW.into());
    assert!(mismatched.validate("owner", "stable-vault").is_err());
    assert!(Registry::parse(
        &" ".repeat(super::MAX_REGISTRY_BYTES + 1),
        "owner",
        "stable-vault"
    )
    .is_err());
}

#[test]
fn installed_mcp_validator_accepts_only_registered_token_and_one_synthetic_tool() {
    let mut registry = Registry::new("owner", "stable-vault");
    let created = registry
        .create(ArtifactKind::McpConfiguration, NOW)
        .unwrap();
    let binding =
        ValidatorBinding::from_artifact(&registry.artifacts[0], &created.presented_id).unwrap();
    let mut validator = InstalledValidator::new(binding.clone()).unwrap();
    let initialized = validator
        .handle(
            &created.presented_id,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            NOW,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        initialized["result"]["serverInfo"]["name"],
        "OpenSesame controlled canary"
    );
    let called=validator.handle(&created.presented_id,r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"canary.status","arguments":{}}}"#,NOW).unwrap().unwrap();
    assert_eq!(
        called["result"]["content"][0]["text"],
        r#"{"environment":"synthetic","status":"available"}"#
    );
    assert_eq!(validator.events.len(), 2);
    for request in [
        r#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":"vault.export","arguments":{}}}"#,
        r#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":"canary.status","arguments":{"secret":"x"}}}"#,
        r#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":"canary.status","url":"https://outside.example"}}"#,
    ] {
        assert!(validator
            .handle(&created.presented_id, request, NOW)
            .is_err());
    }
    assert!(validator
        .handle(
            &mint_presented_id(),
            r#"{"jsonrpc":"2.0","method":"tools/list"}"#,
            NOW
        )
        .is_err());
    let raw = validator.encode().unwrap();
    assert!(!raw.contains(&created.presented_id));
    let loaded = InstalledValidator::parse(&raw, &binding.validator_id).unwrap();
    assert_eq!(loaded.events.len(), 2);
    assert!(InstalledValidator::parse(&raw, &uuid::Uuid::new_v4().to_string()).is_err());
}
#[test]
fn protected_detection_state_rejects_foreign_identity_and_redacts_provision_material() {
    let mut state = DeviceState::new("owner", "stable-vault");
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/app-core/src/lib/credential-observation/protocol-vectors.json"
    ))
    .unwrap();
    let provision: receiver::Provision =
        serde_json::from_value(observation_vector::provision_json(&fixture)).unwrap();
    let now = "2026-10-06T00:00:00.000Z".parse().unwrap();
    state.configure_receiver(provision, now).unwrap();
    assert!(state.enable_receiver(true, now).is_err());
    assert!(state.test_receiver(now).unwrap().is_some());
    let status = state.status().to_string();
    assert!(!status.contains("independentKeyMaterial"));
    assert!(!status.contains("ciphertextB64"));
    let raw = state.encode().unwrap();
    assert!(DeviceState::parse(&raw, "owner", "foreign").is_err());
    let loaded = DeviceState::parse(&raw, "owner", "stable-vault").unwrap();
    assert_eq!(loaded.outbox.entries.len(), 1);
    state.remove_receiver();
    assert!(state.outbox.entries.is_empty());
    assert!(state.status()["receiver"].is_null());
}

#[test]
fn authenticated_digest_retirement_refuses_foreign_bait_duplicates_and_bad_wire() {
    let mut issuer = Registry::new("issuer", "stable-vault");
    let context = ArtifactContext {
        vault_identity: "stable-vault".into(),
        kind: ArtifactKind::ConnectionRef,
        generation: 7,
    };
    let token = mint_presented_id();
    let artifact = issuer
        .register_verified_retired(&context, &token, NOW)
        .unwrap();
    let mut detector = Registry::new("owner", "stable-vault");
    detector
        .import_verified_retirement(&artifact.id, artifact.clone())
        .unwrap();
    assert!(!detector.encode().unwrap().contains(&token));
    assert_eq!(
        detector.probe(&token).unwrap().unwrap().context.generation,
        7
    );
    assert!(detector
        .import_verified_retirement(&artifact.id, artifact.clone())
        .is_err());
    let mut foreign = artifact.clone();
    foreign.context.vault_identity = "foreign".into();
    assert!(Registry::new("owner", "stable-vault")
        .import_verified_retirement(&foreign.id, foreign.clone())
        .is_err());
    let mut bait = artifact.clone();
    bait.state = ArtifactState::Bait;
    assert!(Registry::new("owner", "stable-vault")
        .import_verified_retirement(&bait.id, bait.clone())
        .is_err());
    let mut malformed = artifact.clone();
    malformed.digest_b64 = "invalid".into();
    assert!(Registry::new("owner", "stable-vault")
        .import_verified_retirement(&malformed.id, malformed.clone())
        .is_err());
    let mut mcp = artifact.clone();
    mcp.context.kind = ArtifactKind::McpConfiguration;
    assert!(Registry::new("owner", "stable-vault")
        .import_verified_retirement(&mcp.id, mcp.clone())
        .is_err());
    assert!(Registry::new("owner", "stable-vault")
        .import_verified_retirement(&uuid::Uuid::new_v4().to_string(), artifact)
        .is_err());
}
