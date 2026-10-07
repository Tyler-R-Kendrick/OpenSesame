use super::protocol::{date, decode_digest, valid_text, valid_uuid};
use super::{digest, mint_presented_id, ArtifactContext, ArtifactKind, CanaryError, Phase};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use subtle::ConstantTimeEq;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactState {
    Bait,
    Retired,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub id: String,
    pub context: ArtifactContext,
    pub digest_b64: String,
    pub state: ArtifactState,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<String>,
}

/// Returned once to an authenticated owner; never retained in the registry.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatedArtifact {
    pub id: String,
    pub context: ArtifactContext,
    pub presented_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub v: u32,
    pub event_id: String,
    pub vault_identity: String,
    pub artifact_id: String,
    pub kind: ArtifactKind,
    pub generation: u32,
    pub phase: Phase,
    pub at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    pub v: u32,
    pub tomb: String,
    pub vault_identity: String,
    pub artifacts: Vec<Artifact>,
    pub events: Vec<Event>,
}
impl Registry {
    #[must_use]
    pub fn new(tomb: &str, identity: &str) -> Self {
        Self {
            v: 1,
            tomb: tomb.into(),
            vault_identity: identity.into(),
            artifacts: Vec::new(),
            events: Vec::new(),
        }
    }
    /// # Errors
    /// Refuses corrupt/foreign/unbounded state before any matching takes place.
    pub fn parse(text: &str, tomb: &str, identity: &str) -> Result<Self, CanaryError> {
        if text.len() > super::MAX_REGISTRY_BYTES {
            return Err(CanaryError::Invalid);
        }
        let records: Self = serde_json::from_str(text).map_err(|_| CanaryError::Invalid)?;
        records.validate(tomb, identity)?;
        Ok(records)
    }
    /// # Errors
    /// Validates exact domain identity, closed fields, retention and canonical encodings.
    pub fn validate(&self, tomb: &str, identity: &str) -> Result<(), CanaryError> {
        if self.v != 1
            || self.tomb != tomb
            || self.vault_identity != identity
            || !valid_text(tomb)
            || !valid_text(identity)
            || self.artifacts.len() > super::MAX_ARTIFACTS
            || self.events.len() > super::MAX_EVENTS
        {
            return Err(CanaryError::Invalid);
        }
        let mut ids = HashSet::new();
        let mut digests = HashSet::new();
        for artifact in &self.artifacts {
            artifact.context.validate()?;
            if artifact.context.vault_identity != identity
                || !valid_uuid(&artifact.id)
                || !ids.insert(&artifact.id)
                || !digests.insert(&artifact.digest_b64)
            {
                return Err(CanaryError::Invalid);
            }
            decode_digest(&artifact.digest_b64)?;
            date(&artifact.created_at)?;
            match (artifact.state, &artifact.retired_at) {
                (ArtifactState::Bait, None) => {}
                (ArtifactState::Retired, Some(at)) => {
                    date(at)?;
                }
                _ => return Err(CanaryError::Invalid),
            }
        }
        let mut events = HashSet::new();
        for event in &self.events {
            if event.v != 1
                || !valid_uuid(&event.event_id)
                || !valid_uuid(&event.artifact_id)
                || !events.insert(&event.event_id)
                || event.vault_identity != identity
                || event.generation == 0
            {
                return Err(CanaryError::Invalid);
            }
            date(&event.at)?;
        }
        Ok(())
    }
    /// # Errors
    /// Refuses invalid or unbounded state; never serializes a presented identifier.
    pub fn encode(&self) -> Result<String, CanaryError> {
        self.validate(&self.tomb, &self.vault_identity)?;
        let text = serde_json::to_string(self).map_err(|_| CanaryError::Invalid)?;
        if text.len() > super::MAX_REGISTRY_BYTES {
            return Err(CanaryError::Limit);
        }
        Ok(text)
    }
    /// # Errors
    /// Only trusted owner adapters call creation; bounded cryptographic randomness is mandatory.
    pub fn create(&mut self, kind: ArtifactKind, at: &str) -> Result<CreatedArtifact, CanaryError> {
        let generation = self
            .artifacts
            .iter()
            .filter(|a| a.context.kind == kind)
            .map(|a| a.context.generation)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(CanaryError::Limit)?;
        self.insert(
            kind,
            generation,
            &mint_presented_id(),
            ArtifactState::Bait,
            at,
        )
    }
    /// Issuer integration must verify original issuer identity/generation and atomically revoke
    /// its real authority before registering this observation-only record. Human input is not proof.
    /// # Errors
    /// Refuses duplicate IDs, ambiguous contexts and bounded-retention exhaustion.
    pub fn register_verified_retired(
        &mut self,
        context: &ArtifactContext,
        presented_id: &str,
        at: &str,
    ) -> Result<Artifact, CanaryError> {
        if context.vault_identity != self.vault_identity {
            return Err(CanaryError::ContextMismatch);
        }
        let created = self.insert(
            context.kind,
            context.generation,
            presented_id,
            ArtifactState::Retired,
            at,
        )?;
        self.artifacts
            .iter()
            .find(|a| a.id == created.id)
            .cloned()
            .ok_or(CanaryError::Invalid)
    }
    fn insert(
        &mut self,
        kind: ArtifactKind,
        generation: u32,
        presented_id: &str,
        state: ArtifactState,
        at: &str,
    ) -> Result<CreatedArtifact, CanaryError> {
        self.validate(&self.tomb, &self.vault_identity)?;
        date(at)?;
        if self.artifacts.len() >= super::MAX_ARTIFACTS {
            return Err(CanaryError::Limit);
        }
        if self.probe(presented_id)?.is_some() {
            return Err(CanaryError::Ambiguous);
        }
        let context = ArtifactContext {
            vault_identity: self.vault_identity.clone(),
            kind,
            generation,
        };
        let artifact = Artifact {
            id: uuid::Uuid::new_v4().to_string(),
            digest_b64: STANDARD.encode(digest(&context, presented_id)?),
            context: context.clone(),
            state,
            created_at: at.into(),
            retired_at: (state == ArtifactState::Retired).then(|| at.into()),
        };
        let created = CreatedArtifact {
            id: artifact.id.clone(),
            context,
            presented_id: presented_id.into(),
        };
        self.artifacts.push(artifact);
        if let Err(error) = self.encode() {
            self.artifacts.pop();
            return Err(error);
        }
        Ok(created)
    }
    /// # Errors
    /// Only a separately authenticated issuer adapter may supply this digest-only retirement.
    /// The issuer record is validated again against the original authoritative vault identity.
    pub fn import_verified_retirement(
        &mut self,
        issuer_record_ref: &str,
        artifact: Artifact,
    ) -> Result<(), CanaryError> {
        self.validate(&self.tomb, &self.vault_identity)?;
        if !valid_uuid(issuer_record_ref)
            || artifact.id != issuer_record_ref
            || artifact.context.vault_identity != self.vault_identity
            || artifact.state != ArtifactState::Retired
            || artifact.context.kind == ArtifactKind::McpConfiguration
            || self
                .artifacts
                .iter()
                .any(|known| known.id == artifact.id || known.digest_b64 == artifact.digest_b64)
        {
            return Err(CanaryError::ContextMismatch);
        }
        if self.artifacts.len() >= super::MAX_ARTIFACTS {
            return Err(CanaryError::Limit);
        }
        self.artifacts.push(artifact);
        if let Err(error) = self
            .validate(&self.tomb, &self.vault_identity)
            .and_then(|()| self.encode().map(|_| ()))
        {
            self.artifacts.pop();
            return Err(error);
        }
        Ok(())
    }
    /// # Errors
    /// Refuses ambiguity and invalid registry. A None result for a reserved reference still rejects.
    pub fn probe(&self, presented_id: &str) -> Result<Option<Artifact>, CanaryError> {
        self.validate(&self.tomb, &self.vault_identity)?;
        super::decode_presented_id(presented_id)?;
        let mut found = None;
        for artifact in &self.artifacts {
            if !bool::from(
                digest(&artifact.context, presented_id)?
                    .ct_eq(&decode_digest(&artifact.digest_b64)?),
            ) {
                continue;
            }
            if found.is_some() {
                return Err(CanaryError::Ambiguous);
            }
            found = Some(artifact.clone());
        }
        Ok(found)
    }
}
