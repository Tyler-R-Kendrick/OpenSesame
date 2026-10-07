use crate::credential_canaries::{ArtifactKind, Event, Phase};
use crate::retired_credentials::{DecoyAction, Response};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, SecondsFormat, Timelike, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

pub const PURPOSE: &str = "opensesame/credential-observation/v1";
pub const ACK_PURPOSE: &str = "opensesame/credential-observation/ack/v1";
pub const ROUTE: &str = "/v1/credential-observations";
pub const MAX_PACKAGE_BYTES: usize = 8192;
pub(super) const TTL_MILLIS: i64 = 86_400_000;
pub(super) const SKEW_MILLIS: i64 = 300_000;

#[derive(Debug, Error)]
pub enum ReceiverError {
    #[error("credential observation receiver metadata is invalid")]
    Invalid,
    #[error("credential observation package authentication failed")]
    Authentication,
    #[error("credential observation binding is expired or revoked")]
    Expired,
    #[error("credential observation outbox retention limit reached")]
    Limit,
}

pub(super) fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= max
}
pub(in crate::credential_canaries) fn iso(value: &str) -> Result<DateTime<Utc>, ReceiverError> {
    let date = DateTime::parse_from_rfc3339(value)
        .map_err(|_| ReceiverError::Invalid)?
        .with_timezone(&Utc);
    if value.len() != 24
        || date.nanosecond() >= 1_000_000_000
        || date.to_rfc3339_opts(SecondsFormat::Millis, true) != value
    {
        return Err(ReceiverError::Invalid);
    }
    Ok(date)
}
pub(super) fn b64<const N: usize>(value: &str) -> Result<[u8; N], ReceiverError> {
    let bytes = Zeroizing::new(STANDARD.decode(value).map_err(|_| ReceiverError::Invalid)?);
    let result: [u8; N] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| ReceiverError::Invalid)?;
    if STANDARD.encode(result) != value {
        return Err(ReceiverError::Invalid);
    }
    Ok(result)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provision {
    pub v: u32,
    pub receiver_id: String,
    pub binding_id: String,
    pub origin: String,
    pub independent_key_material_b64: String,
    pub key_epoch: u32,
    pub expires_at: String,
    pub allow_loopback: bool,
}
impl Drop for Provision {
    fn drop(&mut self) {
        self.independent_key_material_b64.zeroize();
    }
}
impl Provision {
    /// # Errors
    /// Provisioning must use one fixed canonical HTTPS origin or explicitly approved loopback.
    pub fn parse(value: &str) -> Result<Self, ReceiverError> {
        if value.len() > MAX_PACKAGE_BYTES {
            return Err(ReceiverError::Invalid);
        }
        let provision: Self = serde_json::from_str(value).map_err(|_| ReceiverError::Invalid)?;
        provision.validate()?;
        Ok(provision)
    }
    /// # Errors
    /// Refuses embedded URL authority, paths, queries, redirects and malformed independent keys.
    pub fn validate(&self) -> Result<(), ReceiverError> {
        if self.v != 1
            || !text(&self.receiver_id, 128)
            || !text(&self.binding_id, 128)
            || self.origin.len() > 2048
        {
            return Err(ReceiverError::Invalid);
        }
        let url = url::Url::parse(&self.origin).map_err(|_| ReceiverError::Invalid)?;
        let loopback = self.allow_loopback
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (!loopback && url.scheme() != "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.origin().ascii_serialization() != self.origin
        {
            return Err(ReceiverError::Invalid);
        }
        iso(&self.expires_at)?;
        let _key = Zeroizing::new(b64::<64>(&self.independent_key_material_b64)?);
        Ok(())
    }
    /// # Errors
    /// Returns only the registered fixed route after validating the owner-provisioned origin.
    pub fn destination(&self) -> Result<String, ReceiverError> {
        self.validate()?;
        Ok(format!("{}{ROUTE}", self.origin))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClosedEvent {
    RetiredCredentialObserved {
        #[serde(rename = "trapId")]
        trap_id: String,
        response: Response,
    },
    SyntheticDecoyInteraction {
        #[serde(rename = "trapId")]
        trap_id: String,
        response: Response,
        action: DecoyAction,
    },
    ControlledCanaryObserved {
        #[serde(rename = "artifactId")]
        artifact_id: String,
        kind: ArtifactKind,
        generation: u32,
        phase: Phase,
    },
    ReceiverTest,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub v: u32,
    pub event_id: String,
    pub vault_identity: String,
    pub event: ClosedEvent,
    pub at: String,
}
impl From<&Event> for Metadata {
    fn from(event: &Event) -> Self {
        Self {
            v: 1,
            event_id: event.event_id.clone(),
            vault_identity: event.vault_identity.clone(),
            event: ClosedEvent::ControlledCanaryObserved {
                artifact_id: event.artifact_id.clone(),
                kind: event.kind,
                generation: event.generation,
                phase: event.phase,
            },
            at: event.at.clone(),
        }
    }
}
impl Metadata {
    /// # Errors
    /// Password observations are normalized from closed local evidence, never submitted secrets.
    pub fn from_password(
        event: &crate::retired_credentials::TrapEvent,
        identity: &str,
    ) -> Result<Self, ReceiverError> {
        use crate::retired_credentials::TrapEvent;
        let (event, at) = match event {
            TrapEvent::RetiredCredentialObserved {
                trap_id,
                at,
                response,
            } => (
                ClosedEvent::RetiredCredentialObserved {
                    trap_id: trap_id.clone(),
                    response: *response,
                },
                at,
            ),
            TrapEvent::SyntheticDecoyInteraction {
                trap_id,
                at,
                response,
                action,
            } => (
                ClosedEvent::SyntheticDecoyInteraction {
                    trap_id: trap_id.clone(),
                    response: *response,
                    action: *action,
                },
                at,
            ),
        };
        let at = DateTime::parse_from_rfc3339(at)
            .map_err(|_| ReceiverError::Invalid)?
            .with_timezone(&Utc);
        let metadata = Self {
            v: 1,
            event_id: uuid::Uuid::new_v4().to_string(),
            vault_identity: identity.into(),
            event,
            at: at.to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        metadata.validate()?;
        Ok(metadata)
    }
    /// # Errors
    /// Rejects arbitrary strings or activity payloads; only closed detection metadata is sealed.
    pub fn validate(&self) -> Result<(), ReceiverError> {
        if self.v != 1
            || !super::super::protocol::valid_uuid(&self.event_id)
            || !text(&self.vault_identity, 256)
        {
            return Err(ReceiverError::Invalid);
        }
        iso(&self.at)?;
        match &self.event {
            ClosedEvent::RetiredCredentialObserved { trap_id, .. } => {
                if !text(trap_id, 128) {
                    return Err(ReceiverError::Invalid);
                }
            }
            ClosedEvent::SyntheticDecoyInteraction {
                trap_id, response, ..
            } => {
                if !text(trap_id, 128) || *response != Response::SyntheticDecoy {
                    return Err(ReceiverError::Invalid);
                }
            }
            ClosedEvent::ControlledCanaryObserved {
                artifact_id,
                generation,
                ..
            } => {
                if !text(artifact_id, 128) || *generation == 0 {
                    return Err(ReceiverError::Invalid);
                }
            }
            ClosedEvent::ReceiverTest => {}
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub v: u32,
    pub package_id: String,
    pub receiver_id: String,
    pub binding_id: String,
    pub key_epoch: u32,
    pub issued_at: String,
    pub expires_at: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub mac_b64: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UnsignedPackage<'a> {
    pub v: u32,
    pub package_id: &'a str,
    pub receiver_id: &'a str,
    pub binding_id: &'a str,
    pub key_epoch: u32,
    pub issued_at: &'a str,
    pub expires_at: &'a str,
    pub nonce_b64: &'a str,
    pub ciphertext_b64: &'a str,
}
impl Package {
    /// # Errors
    /// Validates closed persisted wire shape without treating expired data as live authority.
    pub fn validate_shape(&self) -> Result<(), ReceiverError> {
        if self.v != 1
            || !super::super::protocol::valid_uuid(&self.package_id)
            || !text(&self.receiver_id, 128)
            || !text(&self.binding_id, 128)
            || self.ciphertext_b64.len() > 6000
        {
            return Err(ReceiverError::Invalid);
        }
        iso(&self.issued_at)?;
        iso(&self.expires_at)?;
        b64::<16>(&self.nonce_b64)?;
        b64::<32>(&self.mac_b64)?;
        let cipher = STANDARD
            .decode(&self.ciphertext_b64)
            .map_err(|_| ReceiverError::Invalid)?;
        if cipher.len() < 28 || STANDARD.encode(&cipher) != self.ciphertext_b64 {
            return Err(ReceiverError::Invalid);
        }
        Ok(())
    }
    pub(super) fn body(&self) -> Result<String, ReceiverError> {
        serde_json::to_string(&UnsignedPackage {
            v: self.v,
            package_id: &self.package_id,
            receiver_id: &self.receiver_id,
            binding_id: &self.binding_id,
            key_epoch: self.key_epoch,
            issued_at: &self.issued_at,
            expires_at: &self.expires_at,
            nonce_b64: &self.nonce_b64,
            ciphertext_b64: &self.ciphertext_b64,
        })
        .map_err(|_| ReceiverError::Invalid)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Acknowledgement {
    pub v: u32,
    pub package_id: String,
    pub binding_id: String,
    pub key_epoch: u32,
    pub accepted_at: String,
    pub mac_b64: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedAck<'a> {
    v: u32,
    package_id: &'a str,
    binding_id: &'a str,
    key_epoch: u32,
    accepted_at: &'a str,
}
impl Acknowledgement {
    pub(super) fn body(&self) -> Result<String, ReceiverError> {
        serde_json::to_string(&UnsignedAck {
            v: self.v,
            package_id: &self.package_id,
            binding_id: &self.binding_id,
            key_epoch: self.key_epoch,
            accepted_at: &self.accepted_at,
        })
        .map_err(|_| ReceiverError::Invalid)
    }
}
