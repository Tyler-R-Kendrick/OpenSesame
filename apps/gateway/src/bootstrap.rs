use crate::app_state::Bootstrap;
use crate::config;
use chrono::{Duration, Utc};
use opensesame_audit::ReceiptSigner;
use opensesame_authz::PolicyEngine;
use opensesame_broker::Broker;
use opensesame_connector_host::HostRuntime;
use opensesame_domain::*;
use opensesame_storage::Db;

pub struct BootstrapArtifacts {
    pub demo: Option<Bootstrap>,
    pub connection_ref: Option<ConnectionRef>,
    pub broker: Broker,
}

pub async fn maybe_demo_bootstrap(db: &Db) -> anyhow::Result<BootstrapArtifacts> {
    if !config::dev_bootstrap_enabled() || config::is_production_env() {
        tracing::info!("demo bootstrap skipped (set OPENSESAME_DEV_BOOTSTRAP=true in non-production to enable)");
        return Ok(BootstrapArtifacts {
            demo: None,
            connection_ref: None,
            broker: Broker {
                db: db.clone(),
                policy: PolicyEngine::default(),
                host: HostRuntime::default(),
                signer: ReceiptSigner::generate(),
            },
        });
    }

    tracing::warn!(
        "OPENSESAME_DEV_BOOTSTRAP enabled — seeding demo org/grant (non-production only)"
    );
    create_demo_bootstrap(db).await
}

async fn create_demo_bootstrap(db: &Db) -> anyhow::Result<BootstrapArtifacts> {
    let mut policy = PolicyEngine::default();
    let org = OrganizationId::from_uuid(uuid::Uuid::from_u128(
        0x6f70656e_7365_7361_6d65_000000000001,
    ));
    let project = ProjectId::from_uuid(uuid::Uuid::from_u128(
        0x6f70656e_7365_7361_6d65_000000000002,
    ));
    let principal = PrincipalId::from_uuid(uuid::Uuid::from_u128(
        0x6f70656e_7365_7361_6d65_000000000003,
    ));
    let actor = ActorId::from_uuid(uuid::Uuid::from_u128(
        0x6f70656e_7365_7361_6d65_000000000004,
    ));
    let connection = ConnectionId::from_uuid(uuid::Uuid::from_u128(
        0x6f70656e_7365_7361_6d65_000000000005,
    ));
    db.ensure_organization(&org, "demo").await?;
    db.ensure_project(&project, &org, "catalog").await?;

    policy
        .relationships
        .write(&format!("organization:{org}"), "member", "user:demo");
    policy
        .relationships
        .write(&format!("project:{project}"), "developer", "user:demo");
    // Policy engine connection checks use short ids in fixtures; use "demo-conn"
    policy
        .relationships
        .write("connection:demo-conn", "user", "user:demo");
    policy.assurance.insert("user:demo".into(), "mfa".into());

    let now = Utc::now();
    let grant = Grant {
        id: GrantId::from_uuid(uuid::Uuid::from_u128(
            0x6f70656e_7365_7361_6d65_000000000006,
        )),
        version: 1,
        issuer_principal_id: principal,
        beneficiary_principal_id: principal,
        actor_id: Some(actor),
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: org,
        project_id: Some(project),
        environment_id: None,
        connection_id: Some(connection),
        actions: vec!["repository.read".into(), "pull_request.create".into()],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(8),
            required_assurance: Some("mfa".into()),
            authentication_max_age_seconds: Some(3600),
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: Default::default(),
            maximum_delegation_depth: 0,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    };
    db.upsert_grant(&grant).await?;

    let connection_ref =
        ConnectionRef::new(org, Some(project), "github/main", connection).expect("connection ref");

    let broker = Broker {
        db: db.clone(),
        policy,
        host: HostRuntime::default(),
        signer: ReceiptSigner::generate(),
    };

    let demo = Bootstrap {
        org,
        project,
        principal,
        actor,
        connection,
        grant,
    };

    Ok(BootstrapArtifacts {
        demo: Some(demo),
        connection_ref: Some(connection_ref),
        broker,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn demo_authority_is_stable_across_host_restarts() {
        let db = Db::connect_memory().await.unwrap();
        let first = create_demo_bootstrap(&db).await.unwrap().demo.unwrap();
        let second = create_demo_bootstrap(&db).await.unwrap().demo.unwrap();

        assert_eq!(first.org, second.org);
        assert_eq!(first.project, second.project);
        assert_eq!(first.principal, second.principal);
        assert_eq!(first.grant.id, second.grant.id);
    }
}
