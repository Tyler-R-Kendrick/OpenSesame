//! GA-V-29 — authority evaluation under shuttle interleaving.
//!
//! Two schedulers race ValidatedGrantChain validation: a well-formed child and a
//! forged parent pointer. Evaluation must terminate, and the forged chain must
//! never validate.

#![cfg(feature = "concurrency-test")]

use chrono::{Duration, Utc};
use opensesame_domain::{
    ConnectionId, Grant, GrantConstraints, GrantId, OfflineUse, OrganizationId, PrincipalId,
    ProjectId, ValidatedGrantChain,
};
use shuttle::sync::Arc;

const DEFAULT_ITERATIONS: usize = 1_000;

fn sample(depth: u32, parent: Option<GrantId>, org: OrganizationId) -> Grant {
    let now = Utc::now();
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: PrincipalId::new(),
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: org,
        project_id: Some(ProjectId::new()),
        environment_id: None,
        connection_id: Some(ConnectionId::new()),
        actions: vec!["repository.read".into()],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.example".into()],
            not_before: None,
            expires_at: now + Duration::hours(1),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: [("calls".into(), 10 - i64::from(depth))]
                .into_iter()
                .collect(),
            maximum_delegation_depth: 2,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: parent,
        delegation_depth: depth,
        created_at: now,
        revoked_at: None,
    }
}

#[test]
fn evaluation_cannot_loop_under_adversarial_interleaving() {
    let iterations = std::env::var("SHUTTLE_ITERATIONS").map_or(DEFAULT_ITERATIONS, |raw| {
        raw.parse().expect("SHUTTLE_ITERATIONS must be a usize")
    });
    shuttle::check_random(
        || {
            let org = OrganizationId::new();
            let mut root = sample(0, None, org);
            root.constraints.budgets.insert("calls".into(), 10);
            let mut child = sample(1, Some(root.id), org);
            child.issuer_principal_id = root.beneficiary_principal_id;
            child.connection_id = root.connection_id;
            child.project_id = root.project_id;
            child.constraints.budgets.insert("calls".into(), 5);
            child.constraints.maximum_delegation_depth = 0;
            child.constraints.expires_at = root.constraints.expires_at - Duration::minutes(1);

            let mut forged = child.clone();
            forged.parent_grant_id = Some(GrantId::new());

            let valid = Arc::new(vec![root.clone(), child.clone()]);
            let forged_chain = Arc::new(vec![root, forged]);
            let now = Utc::now();

            let a = shuttle::thread::spawn({
                let valid = Arc::clone(&valid);
                move || {
                    shuttle::thread::yield_now();
                    ValidatedGrantChain::try_validate(&valid, now, 0)
                }
            });
            let b = shuttle::thread::spawn({
                let forged_chain = Arc::clone(&forged_chain);
                move || {
                    shuttle::thread::yield_now();
                    ValidatedGrantChain::try_validate(&forged_chain, now, 0)
                }
            });
            let ok = a.join().expect("valid evaluator");
            let bad = b.join().expect("forged evaluator");
            assert!(
                ok.is_ok(),
                "well-formed chain must validate under interleaving"
            );
            assert!(
                bad.is_err(),
                "forged parent pointer must not validate under interleaving"
            );
        },
        iterations,
    );
}
