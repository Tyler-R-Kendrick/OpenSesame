use super::fixture::{hostile_text, IDENTITY, NOW, TOMB};
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::credential_canaries::{
    digest, encode_presented_id, parse_reference, Artifact, ArtifactContext, ArtifactKind,
    ArtifactState, CanaryResponse, Decision, InstalledValidator, Phase, Registry, ValidatorBinding,
    MAX_REGISTRY_BYTES,
};

pub fn canary_registry(bytes: &[u8]) {
    let raw = hostile_text(bytes, MAX_REGISTRY_BYTES + 1);
    if let Ok(registry) = Registry::parse(&raw, TOMB, IDENTITY) {
        let encoded = registry.encode().unwrap();
        assert_eq!(
            Registry::parse(&encoded, TOMB, IDENTITY)
                .unwrap()
                .encode()
                .unwrap(),
            encoded
        );
        assert!(Registry::parse(&encoded, TOMB, "foreign-vault").is_err());
    }
    let context = ArtifactContext {
        vault_identity: IDENTITY.into(),
        kind: ArtifactKind::McpConfiguration,
        generation: 1,
    };
    let token = encode_presented_id(&std::array::from_fn(|i| bytes.get(i).copied().unwrap_or(0)));
    let registered_digest = digest(&context, &token).unwrap();
    let mut foreign = context.clone();
    foreign.vault_identity.push_str("-foreign");
    assert_ne!(digest(&foreign, &token).unwrap(), registered_digest);
    foreign = context.clone();
    foreign.generation += 1;
    assert_ne!(digest(&foreign, &token).unwrap(), registered_digest);
    let artifact = Artifact {
        id: "11111111-1111-4111-8111-111111111111".into(),
        context,
        digest_b64: STANDARD.encode(registered_digest),
        state: ArtifactState::Bait,
        created_at: NOW.into(),
        retired_at: None,
    };
    let mut registry = Registry::new(TOMB, IDENTITY);
    registry.artifacts.push(artifact.clone());
    let result = registry
        .observe_bound(&artifact.id, &token, Phase::Connected, NOW)
        .unwrap();
    assert!(matches!(
        result.decision,
        Decision::Canary {
            response: CanaryResponse::SyntheticReadonly,
            ..
        }
    ));
    let binding = ValidatorBinding::from_artifact(&artifact, &token).unwrap();
    let mut validator = InstalledValidator::new(binding).unwrap();
    assert!(validator
        .handle(
            &token,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            NOW
        )
        .unwrap()
        .is_some());
    let before = validator.encode().unwrap();
    assert!(validator.handle(&token, r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vault.export","arguments":{}}}"#, NOW).is_err());
    assert_eq!(validator.encode().unwrap(), before);
    if let Ok(installed) = InstalledValidator::parse(&raw, &validator.binding.validator_id) {
        let encoded = installed.encode().unwrap();
        assert!(
            InstalledValidator::parse(&encoded, "22222222-2222-4222-8222-222222222222").is_err()
        );
    }
    // Reserved syntax must be validated; ordinary refs remain outside this detection API.
    let _ = parse_reference(&hostile_text(bytes, 4097));
}
