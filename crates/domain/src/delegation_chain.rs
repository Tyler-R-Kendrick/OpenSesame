//! Ordered delegation chains with cycle and depth validation.

use crate::{DelegationChainId, DomainError, GrantId, PrincipalId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegationHop {
    pub index: u32,
    pub grant_id: GrantId,
    pub issuer_principal_id: PrincipalId,
    pub beneficiary_principal_id: PrincipalId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegationChain {
    pub id: DelegationChainId,
    pub hops: Vec<DelegationHop>,
}

impl DelegationChain {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn validate(&self, max_depth: u32) -> Result<(), DomainError> {
        if self.hops.is_empty() {
            return Ok(());
        }
        if self.hops.len() > max_depth as usize {
            return Err(DomainError::DelegationDepthExceeded);
        }

        let mut seen_grants = std::collections::HashSet::new();
        for (i, hop) in self.hops.iter().enumerate() {
            if usize::try_from(hop.index) != Ok(i) {
                return Err(DomainError::DelegationChainInvalid(format!(
                    "hop index {i} expected, got {}",
                    hop.index
                )));
            }
            if !seen_grants.insert(hop.grant_id) {
                return Err(DomainError::DelegationChainCycle);
            }
        }

        for window in self.hops.windows(2) {
            let prev = &window[0];
            let next = &window[1];
            if prev.beneficiary_principal_id != next.issuer_principal_id {
                return Err(DomainError::DelegationChainInvalid(
                    "beneficiary must match next issuer".into(),
                ));
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn depth(&self) -> u32 {
        u32::try_from(self.hops.len()).unwrap_or(u32::MAX)
    }

    #[must_use]
    pub fn grant_ids(&self) -> Vec<GrantId> {
        self.hops.iter().map(|h| h.grant_id).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(index: u32, issuer: PrincipalId, beneficiary: PrincipalId) -> DelegationHop {
        DelegationHop {
            index,
            grant_id: GrantId::new(),
            issuer_principal_id: issuer,
            beneficiary_principal_id: beneficiary,
        }
    }

    #[test]
    fn valid_chain() {
        let p1 = PrincipalId::new();
        let p2 = PrincipalId::new();
        let p3 = PrincipalId::new();
        let chain = DelegationChain {
            id: DelegationChainId::new(),
            hops: vec![hop(0, p1, p2), hop(1, p2, p3)],
        };
        assert!(chain.validate(3).is_ok());
        assert_eq!(chain.depth(), 2);
    }

    #[test]
    fn rejects_cycle() {
        let p1 = PrincipalId::new();
        let p2 = PrincipalId::new();
        let gid = GrantId::new();
        let chain = DelegationChain {
            id: DelegationChainId::new(),
            hops: vec![
                DelegationHop {
                    index: 0,
                    grant_id: gid,
                    issuer_principal_id: p1,
                    beneficiary_principal_id: p2,
                },
                DelegationHop {
                    index: 1,
                    grant_id: gid,
                    issuer_principal_id: p2,
                    beneficiary_principal_id: p1,
                },
            ],
        };
        assert!(chain.validate(5).is_err());
    }

    #[test]
    fn rejects_depth() {
        let chain = DelegationChain {
            id: DelegationChainId::new(),
            hops: (0..5)
                .map(|i| hop(i, PrincipalId::new(), PrincipalId::new()))
                .collect(),
        };
        assert!(chain.validate(3).is_err());
    }
}
