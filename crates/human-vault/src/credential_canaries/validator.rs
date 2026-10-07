//! An explicitly installed, metadata-only MCP validator; no vault/header/connector port.
use super::{
    protocol::{decode_digest, valid_uuid},
    Artifact, ArtifactContext, ArtifactKind, ArtifactState, CanaryError, Event, Phase, Registry,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidatorBinding {
    pub v: u32,
    pub validator_id: String,
    pub artifact_id: String,
    pub context: ArtifactContext,
    pub digest_b64: String,
}
impl ValidatorBinding {
    /// # Errors
    /// Only explicit controlled MCP metadata can be installed; no key/token/root fields exist.
    pub fn parse(raw: &str) -> Result<Self, CanaryError> {
        if raw.len() > 4096 {
            return Err(CanaryError::Invalid);
        }
        let binding: Self = serde_json::from_str(raw).map_err(|_| CanaryError::Invalid)?;
        binding.validate()?;
        Ok(binding)
    }
    /// # Errors
    /// Binds exact stable context, UUID identity and canonical high-entropy digest.
    pub fn validate(&self) -> Result<(), CanaryError> {
        self.context.validate()?;
        if self.v != 1
            || !valid_uuid(&self.validator_id)
            || !valid_uuid(&self.artifact_id)
            || self.context.kind != ArtifactKind::McpConfiguration
        {
            return Err(CanaryError::Invalid);
        }
        decode_digest(&self.digest_b64)?;
        Ok(())
    }
    /// # Errors
    /// Export requires the once-issued opaque identifier to match the retained registered digest.
    pub fn from_artifact(artifact: &Artifact, presented_id: &str) -> Result<Self, CanaryError> {
        if artifact.context.kind != ArtifactKind::McpConfiguration
            || artifact.state != ArtifactState::Bait
            || super::digest(&artifact.context, presented_id)?
                != decode_digest(&artifact.digest_b64)?
        {
            return Err(CanaryError::ContextMismatch);
        }
        Ok(Self {
            v: 1,
            validator_id: uuid::Uuid::new_v4().to_string(),
            artifact_id: artifact.id.clone(),
            context: artifact.context.clone(),
            digest_b64: artifact.digest_b64.clone(),
        })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstalledValidator {
    pub v: u32,
    pub binding: ValidatorBinding,
    pub events: Vec<Event>,
}
impl InstalledValidator {
    /// # Errors
    /// Installation is an explicit human operation against private detector storage.
    pub fn new(binding: ValidatorBinding) -> Result<Self, CanaryError> {
        binding.validate()?;
        Ok(Self {
            v: 1,
            binding,
            events: vec![],
        })
    }
    /// # Errors
    /// Config token and request context cannot replace the owner-installed authoritative binding.
    pub fn parse(raw: &str, expected_validator_id: &str) -> Result<Self, CanaryError> {
        if raw.len() > super::MAX_REGISTRY_BYTES {
            return Err(CanaryError::Invalid);
        }
        let state: Self = serde_json::from_str(raw).map_err(|_| CanaryError::Invalid)?;
        state.binding.validate()?;
        if state.v != 1 || state.binding.validator_id != expected_validator_id {
            return Err(CanaryError::ContextMismatch);
        }
        state
            .registry()
            .validate("installed-validator", &state.binding.context.vault_identity)?;
        state.encode()?;
        Ok(state)
    }
    fn registry(&self) -> Registry {
        Registry {
            v: 1,
            tomb: "installed-validator".into(),
            vault_identity: self.binding.context.vault_identity.clone(),
            artifacts: vec![Artifact {
                id: self.binding.artifact_id.clone(),
                context: self.binding.context.clone(),
                digest_b64: self.binding.digest_b64.clone(),
                state: ArtifactState::Bait,
                created_at: "1970-01-01T00:00:00.000Z".into(),
                retired_at: None,
            }],
            events: self.events.clone(),
        }
    }
    /// # Errors
    /// Validates exact installed event context and bounds before persisting metadata.
    pub fn encode(&self) -> Result<String, CanaryError> {
        if self.events.iter().any(|event| {
            event.artifact_id != self.binding.artifact_id
                || event.vault_identity != self.binding.context.vault_identity
                || event.kind != self.binding.context.kind
                || event.generation != self.binding.context.generation
        }) {
            return Err(CanaryError::ContextMismatch);
        }
        self.registry()
            .validate("installed-validator", &self.binding.context.vault_identity)?;
        let raw = serde_json::to_string(self).map_err(|_| CanaryError::Invalid)?;
        if raw.len() > super::MAX_REGISTRY_BYTES {
            return Err(CanaryError::Limit);
        }
        Ok(raw)
    }
    /// # Errors
    /// Processes one fixed synthetic tool and emits bounded evidence without any real authority.
    pub fn handle(
        &mut self,
        presented_id: &str,
        raw_request: &str,
        at: &str,
    ) -> Result<Option<Value>, CanaryError> {
        self.encode()?;
        let request = McpRequest::parse(raw_request)?;
        let mut registry = self.registry();
        let phase = if request.method == "tools/call" {
            Phase::Invoked
        } else {
            Phase::Connected
        };
        let observation =
            registry.observe_bound(&self.binding.artifact_id, presented_id, phase, at)?;
        if observation.decision == super::Decision::Unrecognized {
            return Err(CanaryError::Invalid);
        }
        self.events = registry.events;
        Ok(request.response())
    }
}
/// # Errors
/// Validates the single controlled MCP protocol without consulting any credential provider.
pub fn controlled_mcp_response(raw: &str) -> Result<(Phase, Option<Value>), CanaryError> {
    let request = McpRequest::parse(raw)?;
    let phase = if request.method == "tools/call" {
        Phase::Invoked
    } else {
        Phase::Connected
    };
    Ok((phase, request.response()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpRequest {
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}
impl McpRequest {
    fn parse(raw: &str) -> Result<Self, CanaryError> {
        if raw.len() > 4096 {
            return Err(CanaryError::Limit);
        }
        let request: Self = serde_json::from_str(raw).map_err(|_| CanaryError::Invalid)?;
        if request.jsonrpc != "2.0"
            || !matches!(
                request.method.as_str(),
                "initialize" | "notifications/initialized" | "tools/list" | "tools/call"
            )
        {
            return Err(CanaryError::Invalid);
        }
        if let Some(id) = &request.id {
            let valid = match id {
                Value::String(id) => id.encode_utf16().count() <= 128,
                Value::Number(id) => id
                    .as_i64()
                    .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991),
                _ => false,
            };
            if !valid {
                return Err(CanaryError::Invalid);
            }
        }
        if request.method == "tools/call" {
            let params = request
                .params
                .as_ref()
                .and_then(Value::as_object)
                .ok_or(CanaryError::Invalid)?;
            if params.get("name").and_then(Value::as_str) != Some("canary.status")
                || params.keys().any(|key| key != "name" && key != "arguments")
                || params
                    .get("arguments")
                    .is_some_and(|args| !args.as_object().is_some_and(serde_json::Map::is_empty))
            {
                return Err(CanaryError::Invalid);
            }
        }
        Ok(request)
    }
    fn response(&self) -> Option<Value> {
        if self.method == "notifications/initialized" {
            return None;
        }
        let result = match self.method.as_str() {
            "initialize" => {
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"OpenSesame controlled canary","version":"1"}})
            }
            "tools/list" => {
                json!({"tools":[{"name":"canary.status","description":"Read synthetic validator status","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}]})
            }
            _ => {
                json!({"content":[{"type":"text","text":"{\"environment\":\"synthetic\",\"status\":\"available\"}"}]})
            }
        };
        let mut response = json!({"jsonrpc":"2.0","result":result});
        if let Some(id) = &self.id {
            response["id"] = id.clone();
        }
        Some(response)
    }
}
