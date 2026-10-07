//! Genuine public native-engine fixture; no OS/Host authentication is simulated here.
use opensesame_authenticator_core::{
    native_canaries::{
        native_canary_manage, NativeCanaryIssuerProvider, NativeCanaryMutation,
        NativeCanaryOwnerResult,
    },
    retired_gate::{native_gate_create, NativeGateError},
};
use opensesame_human_vault::credential_canaries::{
    mint_presented_id, Artifact, ArtifactContext, ArtifactKind, DeviceState, Registry,
};
use std::sync::atomic::{AtomicUsize, Ordering};

mod observation_vector {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../human-vault/tests/support/credential_observation_vector.rs"
    ));
}

pub const NOW: &str = "2026-10-06T00:00:00.000Z";
pub const OWNER: &str = "public native adapter owner fixture";
const TOMB: &str = "native-wallet-credential-observations.v1";

pub fn gate() -> (String, String) {
    let gate = native_gate_create(OWNER.into()).unwrap();
    let value: serde_json::Value = serde_json::from_str(&gate).unwrap();
    (gate, value["vaultIdentity"].as_str().unwrap().into())
}

pub fn manage(
    gate: &str,
    state: Option<String>,
    mutation: NativeCanaryMutation,
) -> NativeCanaryOwnerResult {
    native_canary_manage(gate.into(), OWNER.into(), state, mutation, NOW.into()).unwrap()
}

pub fn populated_state(identity: &str, count: usize) -> DeviceState {
    let mut state = DeviceState::new(TOMB, identity);
    for _ in 0..count {
        state
            .registry
            .create(ArtifactKind::ConnectionRef, NOW)
            .unwrap();
    }
    state
}

pub fn retirement(identity: &str) -> Artifact {
    let mut registry = Registry::new(TOMB, identity);
    registry
        .register_verified_retired(
            &ArtifactContext {
                vault_identity: identity.into(),
                kind: ArtifactKind::ConnectionRef,
                generation: 1,
            },
            &mint_presented_id(),
            NOW,
        )
        .unwrap()
}

pub struct Issuer {
    pub response: String,
    pub issuer_ref: String,
    pub identity: String,
    pub calls: AtomicUsize,
}
impl Issuer {
    pub fn new(artifact: &Artifact, response: String) -> Self {
        Self {
            response,
            issuer_ref: artifact.id.clone(),
            identity: artifact.context.vault_identity.clone(),
            calls: AtomicUsize::new(0),
        }
    }
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}
impl NativeCanaryIssuerProvider for Issuer {
    fn retire_authenticated(
        &self,
        issuer_ref: String,
        identity: String,
    ) -> Result<String, NativeGateError> {
        assert_eq!(issuer_ref, self.issuer_ref);
        assert_eq!(identity, self.identity);
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.response.clone())
    }
}

pub fn padded_json(raw: &str, length: usize) -> String {
    assert!(raw.len() <= length);
    let result = format!("{raw}{}", " ".repeat(length - raw.len()));
    assert_eq!(result.len(), length);
    let _: serde_json::Value = serde_json::from_str(&result).unwrap();
    result
}

pub fn provision() -> opensesame_human_vault::credential_canaries::receiver::Provision {
    let vector: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/app-core/src/lib/credential-observation/protocol-vectors.json"
    )))
    .unwrap();
    serde_json::from_value(observation_vector::provision_json(&vector)).unwrap()
}
