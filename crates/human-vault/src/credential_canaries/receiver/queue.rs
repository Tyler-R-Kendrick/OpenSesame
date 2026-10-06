//! Persistable sealed-only outbox; transport is deliberately outside this engine.
use super::protocol::{b64, iso, text};
use super::{
    authenticate, seal, verify_acknowledgement, Metadata, Package, Provision, ReceiverError,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const MAX_OUTBOX_BYTES: usize = 65536;
pub const MAX_ENTRIES: usize = 32;
pub const MAX_ATTEMPTS: u32 = 5;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub v: u32,
    pub tomb: String,
    pub vault_identity: String,
    pub revision: String,
    pub provision: Provision,
    pub enabled: bool,
    pub verified: bool,
}
impl Config {
    /// # Errors
    /// Checks authoritative identity and explicit receiver verification.
    pub fn validate(&self, tomb: &str, identity: &str) -> Result<(), ReceiverError> {
        if self.v != 1
            || self.tomb != tomb
            || self.vault_identity != identity
            || !text(tomb, 256)
            || !text(identity, 256)
            || !super::super::protocol::valid_uuid(&self.revision)
            || (self.enabled && !self.verified)
        {
            return Err(ReceiverError::Invalid);
        }
        self.provision.validate()
    }
    #[must_use]
    pub fn allowed(&self, testing: bool, now: DateTime<Utc>) -> bool {
        (testing || (self.enabled && self.verified))
            && iso(&self.provision.expires_at).is_ok_and(|expires| expires > now)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub revision: String,
    pub package: Package,
    pub testing: bool,
    pub attempts: u32,
    pub last_attempt_at: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct History {
    pub fingerprint: String,
    pub at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PasswordSubject<'a> {
    r#type: &'static str,
    trap_id: &'a str,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outbox {
    pub v: u32,
    pub tomb: String,
    pub vault_identity: String,
    pub entries: Vec<Entry>,
    pub history: Vec<History>,
    pub failed: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reservation {
    pub config: Config,
    pub packet: Package,
    pub attempt: u32,
    pub testing: bool,
}
impl Outbox {
    #[must_use]
    pub fn new(tomb: &str, identity: &str) -> Self {
        Self {
            v: 1,
            tomb: tomb.into(),
            vault_identity: identity.into(),
            entries: vec![],
            history: vec![],
            failed: 0,
        }
    }
    /// # Errors
    /// Refuses foreign, duplicate or unbounded persisted entries.
    pub fn validate(&self, tomb: &str, identity: &str) -> Result<(), ReceiverError> {
        if self.v != 1
            || self.tomb != tomb
            || self.vault_identity != identity
            || !text(tomb, 256)
            || !text(identity, 256)
            || self.entries.len() > MAX_ENTRIES
            || self.history.len() > 8
        {
            return Err(ReceiverError::Invalid);
        }
        let mut ids = HashSet::new();
        for entry in &self.entries {
            if !super::super::protocol::valid_uuid(&entry.revision)
                || entry.attempts > MAX_ATTEMPTS
                || !ids.insert(&entry.package.package_id)
                || (entry.attempts == 0) != entry.last_attempt_at.is_none()
            {
                return Err(ReceiverError::Invalid);
            }
            entry.package.validate_shape()?;
            if let Some(at) = &entry.last_attempt_at {
                iso(at)?;
            }
        }
        for entry in &self.history {
            b64::<32>(&entry.fingerprint)?;
            iso(&entry.at)?;
        }
        self.encode()?;
        Ok(())
    }
    /// # Errors
    /// Reads bounded strict metadata; no package is decrypted here.
    pub fn parse(raw: &str, tomb: &str, identity: &str) -> Result<Self, ReceiverError> {
        if raw.len() > MAX_OUTBOX_BYTES {
            return Err(ReceiverError::Limit);
        }
        let result: Self = serde_json::from_str(raw).map_err(|_| ReceiverError::Invalid)?;
        result.validate(tomb, identity)?;
        Ok(result)
    }
    /// # Errors
    /// Enforces the total retention cap before publication.
    pub fn encode(&self) -> Result<String, ReceiverError> {
        let raw = serde_json::to_string(self).map_err(|_| ReceiverError::Invalid)?;
        if raw.len() > MAX_OUTBOX_BYTES {
            return Err(ReceiverError::Limit);
        }
        Ok(raw)
    }
    pub fn discard_expired(&mut self, config: &Config, now: DateTime<Utc>) {
        let before = self.entries.len();
        self.entries.retain(|entry| {
            entry.revision == config.revision
                && iso(&entry.package.expires_at).is_ok_and(|expires| expires > now)
        });
        self.failed = self
            .failed
            .saturating_add(u32::try_from(before - self.entries.len()).unwrap_or(u32::MAX));
        self.history
            .retain(|entry| iso(&entry.at).is_ok_and(|at| now - at < Duration::hours(1)));
    }
    /// # Errors
    /// Seals only closed metadata; saturation leaves local evidence and authority unchanged.
    pub fn append(
        &mut self,
        config: &Config,
        metadata: &Metadata,
        testing: bool,
        now: DateTime<Utc>,
    ) -> Result<Option<String>, ReceiverError> {
        config.validate(&self.tomb, &self.vault_identity)?;
        if metadata.vault_identity != self.vault_identity {
            return Err(ReceiverError::Invalid);
        }
        if !config.allowed(testing, now) {
            return Ok(None);
        }
        self.discard_expired(config, now);
        let raw = match &metadata.event {
            super::ClosedEvent::RetiredCredentialObserved { trap_id, .. } => {
                serde_json::to_vec(&PasswordSubject {
                    r#type: "retired_credential_observed",
                    trap_id,
                })
            }
            _ => serde_json::to_vec(&metadata.event),
        }
        .map_err(|_| ReceiverError::Invalid)?;
        let fingerprint = STANDARD.encode(Sha256::digest(raw));
        if self.entries.len() >= MAX_ENTRIES
            || self.history.len() >= 8
            || self.history.iter().any(|entry| {
                entry.fingerprint == fingerprint
                    && iso(&entry.at).is_ok_and(|at| now - at < Duration::seconds(60))
            })
        {
            return Ok(None);
        }
        let packet = seal(metadata, &config.provision, now)?;
        let id = packet.package_id.clone();
        self.entries.push(Entry {
            revision: config.revision.clone(),
            package: packet,
            testing,
            attempts: 0,
            last_attempt_at: None,
        });
        self.history.push(History {
            fingerprint,
            at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        });
        if self.encode().is_err() {
            self.entries.pop();
            self.history.pop();
            return Ok(None);
        }
        Ok(Some(id))
    }
    /// # Errors
    /// Reserves one authenticated attempt durably before a caller starts transport.
    pub fn reserve(
        &mut self,
        config: &Config,
        package_id: Option<&str>,
        testing: bool,
        now: DateTime<Utc>,
    ) -> Result<Option<Reservation>, ReceiverError> {
        config.validate(&self.tomb, &self.vault_identity)?;
        if !config.allowed(testing, now) {
            return Ok(None);
        }
        self.discard_expired(config, now);
        let candidate = self.entries.iter_mut().find(|entry| {
            entry.testing == testing
                && package_id.is_none_or(|id| entry.package.package_id == id)
                && entry.attempts < MAX_ATTEMPTS
                && entry
                    .last_attempt_at
                    .as_ref()
                    .is_none_or(|at| iso(at).is_ok_and(|at| now - at >= Duration::seconds(5)))
        });
        let Some(entry) = candidate else {
            return Ok(None);
        };
        authenticate(&entry.package, &config.provision, now)?;
        entry.attempts += 1;
        entry.last_attempt_at = Some(now.to_rfc3339_opts(SecondsFormat::Millis, true));
        Ok(Some(Reservation {
            config: config.clone(),
            packet: entry.package.clone(),
            attempt: entry.attempts,
            testing,
        }))
    }
    #[must_use]
    pub fn is_current(
        &self,
        config: &Config,
        reservation: &Reservation,
        now: DateTime<Utc>,
    ) -> bool {
        config.revision == reservation.config.revision
            && serde_json::to_vec(config).ok() == serde_json::to_vec(&reservation.config).ok()
            && config.allowed(reservation.testing, now)
            && self.entries.iter().any(|entry| {
                entry.package.package_id == reservation.packet.package_id
                    && entry.revision == config.revision
                    && entry.attempts == reservation.attempt
                    && entry.testing == reservation.testing
                    && serde_json::to_vec(&entry.package).ok()
                        == serde_json::to_vec(&reservation.packet).ok()
            })
    }
    /// Transport failure remains queued; only the current binding's authenticated ACK removes it.
    pub fn finish(
        &mut self,
        config: &mut Config,
        reservation: &Reservation,
        acknowledgement: Option<&str>,
        now: DateTime<Utc>,
    ) -> bool {
        if !self.is_current(config, reservation, now) {
            return false;
        }
        let success = acknowledgement.is_some_and(|ack| {
            verify_acknowledgement(ack, &reservation.packet, &config.provision, now).is_ok()
        });
        if success {
            self.entries
                .retain(|entry| entry.package.package_id != reservation.packet.package_id);
            if reservation.testing {
                config.verified = true;
            }
        } else {
            self.failed = self.failed.saturating_add(1);
        }
        success
    }
}
