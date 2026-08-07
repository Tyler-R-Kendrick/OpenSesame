use serde::{Deserialize, Serialize};

/// Operation availability classification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AvailabilityClass {
    /// Client-local E2EE operation.
    A0Local,
    /// Previously issued bounded capability with explicit offline permission.
    A1Preauthorized,
    /// New or changed authority (grant, claim, rotate, mint, revoke).
    A2AuthorityRequired,
    /// Irreversible/provider side effect.
    A3ExternalSideEffect,
}

impl AvailabilityClass {
    pub fn requires_authority_quorum(self) -> bool {
        matches!(self, Self::A2AuthorityRequired | Self::A3ExternalSideEffect)
    }

    pub fn allow_without_quorum(self, offline_permitted: bool) -> bool {
        match self {
            Self::A0Local => true,
            Self::A1Preauthorized => offline_permitted,
            Self::A2AuthorityRequired | Self::A3ExternalSideEffect => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quorum_matrix() {
        assert!(AvailabilityClass::A0Local.allow_without_quorum(false));
        assert!(!AvailabilityClass::A1Preauthorized.allow_without_quorum(false));
        assert!(AvailabilityClass::A1Preauthorized.allow_without_quorum(true));
        assert!(!AvailabilityClass::A2AuthorityRequired.allow_without_quorum(true));
        assert!(!AvailabilityClass::A3ExternalSideEffect.allow_without_quorum(true));
    }
}
