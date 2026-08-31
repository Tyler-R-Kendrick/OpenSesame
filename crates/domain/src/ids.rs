use crate::DomainError;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! opaque_id {
    ($name:ident, $prefix:literal) => {
        // `Ord` so ids can live in a `BTreeSet` — a row-scoped session grant
        // (ADR 0079) needs its item set ordered so the same scope always
        // serializes the same way. Ordering is the underlying UUID's and
        // carries no meaning of its own.
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            #[must_use]
            pub fn from_uuid(id: Uuid) -> Self {
                Self(id)
            }

            #[must_use]
            pub fn as_uuid(&self) -> Uuid {
                self.0
            }

            ///
            /// # Errors
            ///
            /// Returns an error when validation or the underlying operation fails.
            pub fn parse(s: &str) -> Result<Self, DomainError> {
                let rest = s.strip_prefix(concat!($prefix, ":")).unwrap_or(s);
                let id =
                    Uuid::parse_str(rest).map_err(|_| DomainError::InvalidId(s.to_string()))?;
                Ok(Self(id))
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}:{}", $prefix, self.0)
            }
        }
    };
}

opaque_id!(OrganizationId, "org");
opaque_id!(TeamId, "team");
opaque_id!(ProjectId, "project");
opaque_id!(EnvironmentId, "env");
opaque_id!(ApplicationId, "app");
opaque_id!(PrincipalId, "principal");
opaque_id!(ActorId, "actor");
opaque_id!(ActorInstanceId, "instance");
opaque_id!(ClientId, "client");
opaque_id!(OperatorId, "operator");
opaque_id!(GrantId, "grant");
opaque_id!(IntentId, "intent");
opaque_id!(InvocationId, "invocation");
opaque_id!(ReceiptId, "receipt");
opaque_id!(ConnectionId, "connection");
opaque_id!(ConnectorDefinitionId, "connector");
opaque_id!(CredentialHandleId, "cred");
opaque_id!(ClaimSessionId, "claim");
opaque_id!(ApprovalId, "approval");
opaque_id!(VaultId, "vault");
opaque_id!(RotationPolicyId, "rotpol");
opaque_id!(RotationRunId, "rotrun");
opaque_id!(CertificateId, "cert");
opaque_id!(ActionId, "action");
opaque_id!(TaskTemplateId, "tasktpl");
opaque_id!(TaskRunId, "taskrun");
opaque_id!(CapabilityStateTransitionId, "captrans");
opaque_id!(AuthorityContextId, "authctx");
opaque_id!(ProofKeyId, "proofkey");
opaque_id!(ProtectedResourceId, "resource");
opaque_id!(ResourceAccountRefId, "acctref");
opaque_id!(MediationPointId, "mediation");
opaque_id!(EnforcementAcknowledgementId, "enfack");
opaque_id!(DelegationChainId, "delchain");
opaque_id!(VerificationEvidenceId, "verevid");
opaque_id!(TaskCredentialId, "taskcred");
opaque_id!(SessionId, "session");
opaque_id!(SessionGrantId, "sgrant");
opaque_id!(JoinRequestId, "joinreq");
opaque_id!(VaultItemId, "item");

/// Stable profile IDs derived from slug strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProtocolProfileId(Uuid);

impl ProtocolProfileId {
    #[must_use]
    pub fn from_slug(slug: &str) -> Self {
        let hash = blake3::hash(slug.as_bytes());
        let mut uuid_bytes = [0u8; 16];
        uuid_bytes.copy_from_slice(&hash.as_bytes()[..16]);
        uuid_bytes[6] = (uuid_bytes[6] & 0x0f) | 0x40;
        uuid_bytes[8] = (uuid_bytes[8] & 0x3f) | 0x80;
        Self(Uuid::from_bytes(uuid_bytes))
    }

    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    #[must_use]
    pub fn from_uuid(id: Uuid) -> Self {
        Self(id)
    }

    #[must_use]
    pub fn as_uuid(&self) -> Uuid {
        self.0
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn parse(s: &str) -> Result<Self, DomainError> {
        let rest = s.strip_prefix("profile:").unwrap_or(s);
        let id = Uuid::parse_str(rest).map_err(|_| DomainError::InvalidId(s.to_string()))?;
        Ok(Self(id))
    }
}

impl Default for ProtocolProfileId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for ProtocolProfileId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "profile:{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_prefixed_ids() {
        let id = OrganizationId::new();
        let s = id.to_string();
        assert!(s.starts_with("org:"));
        assert_eq!(OrganizationId::parse(&s).unwrap(), id);
    }

    #[test]
    fn reject_wrong_prefix() {
        let id = ProjectId::new();
        assert!(OrganizationId::parse(&id.to_string()).is_err());
    }

    #[test]
    fn never_use_email_as_id() {
        assert!(PrincipalId::parse("user@example.com").is_err());
    }
}
