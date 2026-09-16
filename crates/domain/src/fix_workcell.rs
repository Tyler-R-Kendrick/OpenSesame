//! FIX-WORKCELL — omitted child budgets and spawn-depth refusal (domain path).

use crate::{
    grant_budgets::validate_budget_attenuation, DelegationChain, DelegationChainId, DelegationHop,
    DomainError, GrantId, PrincipalId,
};
use std::collections::BTreeMap;

fn meters(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), *value))
        .collect()
}

fn hop(index: u32, issuer: PrincipalId, beneficiary: PrincipalId) -> DelegationHop {
    DelegationHop {
        index,
        grant_id: GrantId::new(),
        issuer_principal_id: issuer,
        beneficiary_principal_id: beneficiary,
    }
}

#[test]
fn fix_workcell_omitted_child_budget_cannot_erase_parent_cap() {
    let parent = meters(&[("api_calls", 100), ("live_instances", 4)]);
    assert!(
        matches!(
            validate_budget_attenuation(&parent, &meters(&[])),
            Err(DomainError::GrantAttenuation(_))
        ),
        "omitting every child budget must refuse rather than erase the parent cap"
    );
    assert!(
        matches!(
            validate_budget_attenuation(&parent, &meters(&[("api_calls", 50)])),
            Err(DomainError::GrantAttenuation(_))
        ),
        "dropping live_instances while keeping api_calls is still erasure"
    );
    assert!(validate_budget_attenuation(
        &parent,
        &meters(&[("api_calls", 50), ("live_instances", 2)])
    )
    .is_ok());
}

#[test]
fn fix_workcell_spawn_depth_refusal() {
    // Explicit delegation depth ceiling of 2 hops (orchestrator + one worker).
    let max_depth = 2;
    let mut principals = vec![PrincipalId::new()];
    for _ in 0..3 {
        principals.push(PrincipalId::new());
    }
    let hops: Vec<DelegationHop> = (0..3)
        .map(|i| hop(i, principals[i as usize], principals[i as usize + 1]))
        .collect();
    let chain = DelegationChain {
        id: DelegationChainId::new(),
        hops,
    };
    assert!(
        matches!(
            chain.validate(max_depth),
            Err(DomainError::DelegationDepthExceeded)
        ),
        "spawn past the authorized depth must refuse"
    );
    assert!(DelegationChain {
        id: DelegationChainId::new(),
        hops: vec![
            hop(0, principals[0], principals[1]),
            hop(1, principals[1], principals[2]),
        ],
    }
    .validate(max_depth)
    .is_ok());
}
