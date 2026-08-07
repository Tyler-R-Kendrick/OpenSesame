use crate::DomainError;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! opaque_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn from_uuid(id: Uuid) -> Self {
                Self(id)
            }

            pub fn as_uuid(&self) -> Uuid {
                self.0
            }

            pub fn parse(s: &str) -> Result<Self, DomainError> {
                let rest = s
                    .strip_prefix(concat!($prefix, ":"))
                    .unwrap_or(s);
                let id = Uuid::parse_str(rest)
                    .map_err(|_| DomainError::InvalidId(s.to_string()))?;
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
