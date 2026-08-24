use std::collections::BTreeMap;

use crate::app_state::Bootstrap;
use crate::config;
use chrono::{Duration, Utc};
use opensesame_authz::PolicyEngine;
use opensesame_broker::Broker;
use opensesame_connector_host::HostRuntime;
use opensesame_domain::{
    ActorId, ConnectionId, ConnectionRecord, ConnectionRef, Grant, GrantConstraints, GrantId,
    OfflineUse, OrganizationId, PrincipalId, ProjectId,
};
use opensesame_storage::Db;

pub struct BootstrapArtifacts {
    pub demo: Option<Bootstrap>,
    pub connection_ref: Option<ConnectionRef>,
    pub broker: Broker,
}

pub async fn maybe_demo_bootstrap(db: &Db) -> anyhow::Result<BootstrapArtifacts> {
    let signer = config::resolve_receipt_signer().map_err(anyhow::Error::msg)?;
    if !config::dev_bootstrap_enabled() || config::is_production_env() {
        tracing::info!("demo bootstrap skipped (set OPENSESAME_DEV_BOOTSTRAP=true in non-production to enable)");
        return Ok(BootstrapArtifacts {
            demo: None,
            connection_ref: None,
            broker: Broker {
                db: db.clone(),
                policy: PolicyEngine::default(),
                host: HostRuntime::default(),
                signer,
            },
        });
    }

    tracing::warn!(
        "OPENSESAME_DEV_BOOTSTRAP enabled — seeding demo org/grant (non-production only)"
    );
    create_demo_bootstrap(db, signer).await
}

pub(crate) async fn create_demo_bootstrap(
    db: &Db,
    signer: opensesame_audit::ReceiptSigner,
) -> anyhow::Result<BootstrapArtifacts> {
    let mut policy = PolicyEngine::default();
    let org = OrganizationId::new();
    let project = ProjectId::new();
    let principal = PrincipalId::new();
    let actor = ActorId::new();
    let connection = ConnectionId::new();
    db.create_organization(&org, "demo").await?;
    db.create_project(&project, &org, "catalog").await?;

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
    db.insert_connection(&ConnectionRecord {
        id: connection,
        organization_id: org,
        project_id: Some(project),
        provider_id: "sealed-local".into(),
        display_name: "GitHub demo".into(),
        public_config: serde_json::json!({"service": "github", "environment": "demo"}),
        credential_ref: None,
        created_at: now,
        updated_at: now,
    })
    .await?;
    let grant = Grant {
        id: GrantId::new(),
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
            budgets: BTreeMap::default(),
            maximum_delegation_depth: 0,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    };
    db.insert_grant(&grant).await?;

    let connection_ref =
        ConnectionRef::new(org, Some(project), "github/main", connection).expect("connection ref");

    let broker = Broker {
        db: db.clone(),
        policy,
        host: HostRuntime::default(),
        signer,
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
