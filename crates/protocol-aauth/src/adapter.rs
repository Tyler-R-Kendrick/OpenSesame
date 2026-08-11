//! Lossless AAuth draft-10 → OpenSesame domain mappings.

use crate::error::AAuthError;
use opensesame_domain::{digest_sha256, ActorId, ActorInstanceId, PrincipalId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// AAuth Person (draft-10).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub id: String,
    pub display_name: Option<String>,
}

/// AAuth Agent (draft-10).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub instance_id: String,
}

/// AAuth Mission — opaque policy bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mission {
    pub bytes: Vec<u8>,
}

/// OpenSesame governance context derived from a mission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GovernanceContext {
    pub mission_digest: String,
    pub mission_bytes_len: usize,
}

/// Protocol token identity as `(issuer, jti)` per ADR 0029.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProtocolTokenRef {
    pub issuer: String,
    pub jti: String,
}

/// Lossless Person mapping — preserves source id for round-trip.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MappedPerson {
    pub principal_id: PrincipalId,
    pub source_person_id: String,
}

/// Lossless Agent mapping — preserves source ids for round-trip.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MappedAgent {
    pub actor_id: ActorId,
    pub instance_id: ActorInstanceId,
    pub source_agent_id: String,
    pub source_instance_id: String,
}

fn deterministic_uuid(domain: &str, source_id: &str) -> Uuid {
    let hash = blake3::hash(format!("{domain}:{source_id}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash.as_bytes()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

pub fn map_person(person: &Person) -> MappedPerson {
    MappedPerson {
        principal_id: PrincipalId::from_uuid(deterministic_uuid("aauth-person", &person.id)),
        source_person_id: person.id.clone(),
    }
}

pub fn unmap_person(mapped: &MappedPerson) -> Person {
    Person {
        id: mapped.source_person_id.clone(),
        display_name: None,
    }
}

pub fn map_agent(agent: &Agent) -> MappedAgent {
    MappedAgent {
        actor_id: ActorId::from_uuid(deterministic_uuid("aauth-agent", &agent.id)),
        instance_id: ActorInstanceId::from_uuid(deterministic_uuid(
            "aauth-instance",
            &agent.instance_id,
        )),
        source_agent_id: agent.id.clone(),
        source_instance_id: agent.instance_id.clone(),
    }
}

pub fn mission_to_governance_context(mission: &Mission) -> GovernanceContext {
    GovernanceContext {
        mission_digest: digest_sha256(&mission.bytes),
        mission_bytes_len: mission.bytes.len(),
    }
}

/// Single-principal invariant: one person maps to one principal id.
pub fn assert_one_person(persons: &[Person]) -> Result<MappedPerson, AAuthError> {
    match persons {
        [person] => Ok(map_person(person)),
        _ => Err(AAuthError::MultiplePersons),
    }
}
