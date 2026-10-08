//! Protected detection state, independent of the real vault root and admission session.
use super::{
    receiver::{ClosedEvent, Config, Metadata, Outbox, Provision, ReceiverError},
    Registry,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
pub const MAX_DEVICE_STATE_BYTES: usize = 131_072;
/// Private native sender proof: the public receiver packet has no owner/root witness fields.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerTestWitness {
    pub package_id: String,
    pub manifest_digest_b64: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceState {
    pub v: u32,
    pub registry: Registry,
    pub receiver: Option<Config>,
    pub outbox: Outbox,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owner_test_witnesses: Vec<OwnerTestWitness>,
}
impl DeviceState {
    #[must_use]
    pub fn new(tomb: &str, identity: &str) -> Self {
        Self {
            v: 1,
            registry: Registry::new(tomb, identity),
            receiver: None,
            outbox: Outbox::new(tomb, identity),
            owner_test_witnesses: Vec::new(),
        }
    }
    /// # Errors
    /// Refuses all malformed, foreign or over-retained state before local validation.
    pub fn parse(raw: &str, tomb: &str, identity: &str) -> Result<Self, ReceiverError> {
        if raw.len() > MAX_DEVICE_STATE_BYTES {
            return Err(ReceiverError::Limit);
        }
        let state: Self = serde_json::from_str(raw).map_err(|_| ReceiverError::Invalid)?;
        state.validate(tomb, identity)?;
        Ok(state)
    }
    /// # Errors
    /// Every component binds to the independently authoritative stable vault identity.
    pub fn validate(&self, tomb: &str, identity: &str) -> Result<(), ReceiverError> {
        if self.v != 1 {
            return Err(ReceiverError::Invalid);
        }
        self.registry
            .validate(tomb, identity)
            .map_err(|_| ReceiverError::Invalid)?;
        self.registry.encode().map_err(|_| ReceiverError::Limit)?;
        self.outbox.validate(tomb, identity)?;
        if self.owner_test_witnesses.len() > super::receiver::MAX_ENTRIES {
            return Err(ReceiverError::Limit);
        }
        let mut seen = std::collections::HashSet::new();
        for witness in &self.owner_test_witnesses {
            if !super::protocol::valid_uuid(&witness.package_id)
                || !seen.insert(&witness.package_id)
                || super::protocol::decode_digest(&witness.manifest_digest_b64).is_err()
            {
                return Err(ReceiverError::Invalid);
            }
        }
        if let Some(receiver) = &self.receiver {
            receiver.validate(tomb, identity)?;
        } else if !self.outbox.entries.is_empty() {
            return Err(ReceiverError::Invalid);
        }
        self.encode()?;
        Ok(())
    }
    /// # Errors
    /// Enforces the complete OS/software-protected state size cap.
    pub fn encode(&self) -> Result<String, ReceiverError> {
        let raw = serde_json::to_string(self).map_err(|_| ReceiverError::Invalid)?;
        if raw.len() > MAX_DEVICE_STATE_BYTES {
            return Err(ReceiverError::Limit);
        }
        Ok(raw)
    }
    /// Requires the caller's fresh genuine owner proof and explicit named-destination consent.
    /// # Errors
    /// Refuses invalid/expired provisioning; replacement drops all unsent old binding packages.
    pub fn configure_receiver(
        &mut self,
        provision: Provision,
        now: DateTime<Utc>,
    ) -> Result<(), ReceiverError> {
        provision.validate()?;
        if super::receiver::protocol::iso(&provision.expires_at)? <= now {
            return Err(ReceiverError::Expired);
        }
        self.receiver = Some(Config {
            v: 1,
            tomb: self.registry.tomb.clone(),
            vault_identity: self.registry.vault_identity.clone(),
            revision: uuid::Uuid::new_v4().to_string(),
            provision,
            enabled: false,
            verified: false,
        });
        self.outbox.entries.clear();
        self.owner_test_witnesses.clear();
        Ok(())
    }
    /// Removal is local revocation; an already sent request cannot be recalled remotely.
    pub fn remove_receiver(&mut self) {
        self.receiver = None;
        self.outbox.entries.clear();
        self.owner_test_witnesses.clear();
    }
    /// # Errors
    /// Enabling requires an authenticated current-binding test acknowledgement.
    pub fn enable_receiver(
        &mut self,
        enabled: bool,
        now: DateTime<Utc>,
    ) -> Result<(), ReceiverError> {
        let config = self.receiver.as_mut().ok_or(ReceiverError::Invalid)?;
        if enabled
            && (!config.verified
                || super::receiver::protocol::iso(&config.provision.expires_at)? <= now)
        {
            return Err(ReceiverError::Invalid);
        }
        config.enabled = enabled;
        if !enabled {
            self.outbox.entries.clear();
            self.owner_test_witnesses.clear();
        }
        Ok(())
    }
    /// # Errors
    /// Only current selected provisioning can enqueue a closed local test.
    pub fn test_receiver(&mut self, now: DateTime<Utc>) -> Result<Option<String>, ReceiverError> {
        let config = self.receiver.as_ref().ok_or(ReceiverError::Invalid)?;
        let metadata = Metadata {
            v: 1,
            event_id: uuid::Uuid::new_v4().to_string(),
            vault_identity: self.registry.vault_identity.clone(),
            event: ClosedEvent::ReceiverTest,
            at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        self.outbox.append(config, &metadata, true, now)
    }
    /// # Errors
    /// Receiver absence/offline/saturation never changes local classification or authority.
    pub fn queue(
        &mut self,
        metadata: &Metadata,
        now: DateTime<Utc>,
    ) -> Result<Option<String>, ReceiverError> {
        let Some(config) = &self.receiver else {
            return Ok(None);
        };
        self.outbox.append(config, metadata, false, now)
    }
    /// Redacted owner status excludes all raw canary IDs, verifier digests and receiver key material.
    #[must_use]
    pub fn status(&self) -> serde_json::Value {
        let artifacts:Vec<_>=self.registry.artifacts.iter().map(|artifact|serde_json::json!({"id":artifact.id,"context":artifact.context,"state":artifact.state,"createdAt":artifact.created_at,"retiredAt":artifact.retired_at})).collect();
        let receiver=self.receiver.as_ref().map(|config|serde_json::json!({"receiverId":config.provision.receiver_id,"bindingId":config.provision.binding_id,"origin":config.provision.origin,"keyEpoch":config.provision.key_epoch,"expiresAt":config.provision.expires_at,"enabled":config.enabled,"verified":config.verified}));
        serde_json::json!({"artifacts":artifacts,"events":self.registry.events,"receiver":receiver,"queued":self.outbox.entries.iter().filter(|entry|entry.attempts<super::receiver::MAX_ATTEMPTS).count(),"failed":self.outbox.failed})
    }
}
