use super::protocol::{date, decode_digest};
use super::{digest, ArtifactState, CanaryError, Event, Phase, Registry};
use serde::Serialize;
use subtle::ConstantTimeEq;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Decision {
    #[serde(rename_all = "camelCase")]
    Canary {
        artifact_id: String,
        response: CanaryResponse,
    },
    Unrecognized,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CanaryResponse {
    Reject,
    SyntheticReadonly,
}

pub struct Observation {
    pub decision: Decision,
    pub event: Option<Event>,
}
impl Registry {
    /// A validator resolves `artifact_id` from its registered binding, never client context.
    /// # Errors
    /// Corrupt bindings and invalid clocks fail closed. Caps suppress evidence, never classification.
    pub fn observe_bound(
        &mut self,
        artifact_id: &str,
        presented_id: &str,
        phase: Phase,
        at: &str,
    ) -> Result<Observation, CanaryError> {
        self.validate(&self.tomb, &self.vault_identity)?;
        let now = date(at)?;
        let artifact = self
            .artifacts
            .iter()
            .find(|a| a.id == artifact_id)
            .ok_or(CanaryError::ContextMismatch)?;
        let matched = digest(&artifact.context, presented_id)?;
        if !bool::from(matched.ct_eq(&decode_digest(&artifact.digest_b64)?)) {
            return Ok(Observation {
                decision: Decision::Unrecognized,
                event: None,
            });
        }
        if phase == Phase::RetiredGenerationObserved && artifact.state != ArtifactState::Retired {
            return Err(CanaryError::ContextMismatch);
        }
        let response = if artifact.state == ArtifactState::Bait
            && artifact.context.kind == super::ArtifactKind::McpConfiguration
        {
            CanaryResponse::SyntheticReadonly
        } else {
            CanaryResponse::Reject
        };
        let decision = Decision::Canary {
            artifact_id: artifact.id.clone(),
            response,
        };
        let mut recent = 0;
        for event in &self.events {
            if event.artifact_id != artifact_id {
                continue;
            }
            let elapsed = now.signed_duration_since(date(&event.at)?).num_seconds();
            if elapsed < 0 {
                return Err(CanaryError::Invalid);
            }
            if elapsed < 60 && event.phase == phase {
                return Ok(Observation {
                    decision,
                    event: None,
                });
            }
            if elapsed < 3600 {
                recent += 1;
            }
        }
        if recent >= 8 || self.events.len() >= super::MAX_EVENTS {
            return Ok(Observation {
                decision,
                event: None,
            });
        }
        let event = Event {
            v: 1,
            event_id: uuid::Uuid::new_v4().to_string(),
            vault_identity: self.vault_identity.clone(),
            artifact_id: artifact.id.clone(),
            kind: artifact.context.kind,
            generation: artifact.context.generation,
            phase,
            at: at.into(),
        };
        self.events.push(event.clone());
        if self.encode().is_err() {
            self.events.pop();
            return Ok(Observation {
                decision,
                event: None,
            });
        }
        Ok(Observation {
            decision,
            event: Some(event),
        })
    }
}
