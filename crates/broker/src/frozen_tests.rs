use super::*;
use chrono::Duration;
use opensesame_audit::ReceiptSigner;
use opensesame_authz::PolicyEngine;
use opensesame_connector_host::HostRuntime;
use opensesame_domain::{
    ActorId, ActorInstanceId, AuthorityContext, AuthorityContextId, AuthorityContextMode,
    CapabilitySet, CeilingInput, ClientId, ConnectionId, GrantConstraints, GrantId, IntentId,
    OfflineUse, OrganizationId, PrincipalId, ProjectId, ResourceSelector, TaskRunId,
    TaskTemplateId, FROZEN_INTENT_SCHEMA_VERSION,
};
use opensesame_storage::Db;
use opensesame_task_access::{InMemoryTaskStore, StartTaskParams};

type Narrowing = (&'static str, fn(&mut Grant));

fn sample_grant(org: OrganizationId, principal: PrincipalId) -> Grant {
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: principal,
        beneficiary_principal_id: principal,
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: org,
        project_id: None,
        environment_id: None,
        connection_id: None,
        actions: vec!["read".into()],
        resources: vec!["doc:1".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://rs.example".into()],
            not_before: None,
            expires_at: Utc::now() + Duration::hours(1),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 2,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: Utc::now(),
        revoked_at: None,
    }
}

fn sample_intent(org: OrganizationId, principal: PrincipalId) -> FrozenIntentV2 {
    FrozenIntentV2 {
        schema_version: FROZEN_INTENT_SCHEMA_VERSION,
        id: IntentId::new(),
        task_run_id: TaskRunId::new(),
        task_state_version: 1,
        task_state_digest: "sha256:state".into(),
        organization_id: org,
        project_id: None,
        principal_id: principal,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: "read".into(),
        resource: "doc:1".into(),
        audience: "https://rs.example".into(),
        canonical_arguments: json!({}),
        body_hash: None,
        nonce: "n".into(),
        idempotency_key: "idem".into(),
        issued_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(5),
        intent_digest: String::new(),
    }
}

#[test]
fn a_grant_only_covers_what_it_was_narrowed_to() {
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let unscoped = sample_grant(org, principal);
    let intent = sample_intent(org, principal);
    // Nothing narrowed but the organization and the beneficiary: covered.
    assert!(assert_grant_covers_frozen_intent(&unscoped, &intent).is_ok());

    // A grant belongs to its beneficiary, not to whoever presents it.
    let mut other_beneficiary = unscoped.clone();
    other_beneficiary.beneficiary_principal_id = PrincipalId::new();
    assert!(assert_grant_covers_frozen_intent(&other_beneficiary, &intent).is_err());

    // An intent that names nothing does not satisfy a grant that names
    // something: that reading is how a scoped grant became an unscoped one.
    let project = ProjectId::new();
    let mut scoped = unscoped.clone();
    scoped.project_id = Some(project);
    assert!(assert_grant_covers_frozen_intent(&scoped, &intent).is_err());
    let mut in_project = intent.clone();
    in_project.project_id = Some(project);
    assert!(assert_grant_covers_frozen_intent(&scoped, &in_project).is_ok());
    in_project.project_id = Some(ProjectId::new());
    assert!(assert_grant_covers_frozen_intent(&scoped, &in_project).is_err());

    let narrowings: [Narrowing; 4] = [
        ("actor", |g| g.actor_id = Some(ActorId::new())),
        ("actor instance", |g| {
            g.actor_instance_id = Some(ActorInstanceId::new());
        }),
        ("client", |g| g.client_id = Some(ClientId::new())),
        ("connection", |g| {
            g.connection_id = Some(ConnectionId::new());
        }),
    ];
    for (what, narrow) in narrowings {
        let mut g = unscoped.clone();
        narrow(&mut g);
        assert!(
            assert_grant_covers_frozen_intent(&g, &intent).is_err(),
            "a grant narrowed to one {what} must not cover an intent that names none"
        );
    }

    // The actor the grant names is the actor that must appear.
    let mut actor_scoped = unscoped.clone();
    actor_scoped.actor_id = Some(intent.actor_id);
    assert!(assert_grant_covers_frozen_intent(&actor_scoped, &intent).is_ok());
}

#[tokio::test]
async fn frozen_receipts_bind_the_organization_across_idempotent_replay() {
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let capabilities = CapabilitySet::new(vec![Capability::new(
        "read",
        ResourceSelector::exact("doc:1"),
    )]);
    let tasks = TaskAccessEngine::new(InMemoryTaskStore::new());
    let ceiling = tasks
        .compile_ceiling(
            vec![CeilingInput {
                principal_id: principal,
                capabilities: capabilities.clone(),
            }],
            Utc::now(),
        )
        .unwrap();
    let run = tasks
        .start_task(StartTaskParams {
            template_id: TaskTemplateId::new(),
            authority_context: AuthorityContext {
                id: AuthorityContextId::new(),
                mode: AuthorityContextMode::SinglePrincipal,
                organization_id: org,
                project_id: None,
                principal_ids: vec![principal],
                capability_ceiling: capabilities,
                compiled_at: Utc::now(),
            },
            ceiling,
            maximum_expires_at: Utc::now() + Duration::hours(1),
            now: Utc::now(),
        })
        .unwrap();
    let mut intent = sample_intent(org, principal);
    intent.task_run_id = run.id;
    intent.task_state_version = run.state_version;
    intent.task_state_digest = run.state_digest;

    let db = Db::connect_memory().await.unwrap();
    db.create_organization(&org, "frozen").await.unwrap();
    let mut policy = PolicyEngine::default();
    policy
        .relationships
        .write("connection:demo-conn", "user", "user:demo");
    let broker = Broker {
        db,
        policy,
        host: HostRuntime::default(),
        signer: ReceiptSigner::generate(),
    };
    let invoke = || FrozenInvokeInput {
        intent: intent.clone(),
        grant: sample_grant(org, principal),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        required_capability: Capability::new("read", ResourceSelector::exact("doc:1")),
        lineage: None,
    };

    let first = broker.invoke_frozen(&tasks, invoke()).await.unwrap();
    let replay = broker.invoke_frozen(&tasks, invoke()).await.unwrap();
    assert_eq!(first.id, replay.id);
    assert_eq!(first.organization_id, Some(org));
    assert_eq!(first.receipt_schema_version, 3);
    assert_eq!(replay.organization_id, Some(org));
    assert_eq!(broker.db.count_receipts().await.unwrap(), 1);
}

#[tokio::test]
async fn mutation_after_freeze_rejected_by_digest() {
    let caps = CapabilitySet::new(vec![Capability::new(
        "read",
        ResourceSelector::exact("doc:1"),
    )]);
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let ctx = AuthorityContext {
        id: AuthorityContextId::new(),
        mode: AuthorityContextMode::SinglePrincipal,
        organization_id: org,
        project_id: None,
        principal_ids: vec![principal],
        capability_ceiling: caps.clone(),
        compiled_at: Utc::now(),
    };
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
    let ceiling = engine
        .compile_ceiling(
            vec![CeilingInput {
                principal_id: principal,
                capabilities: caps.clone(),
            }],
            Utc::now(),
        )
        .unwrap();
    let run = engine
        .start_task(StartTaskParams {
            template_id: TaskTemplateId::new(),
            authority_context: ctx,
            ceiling,
            maximum_expires_at: Utc::now() + Duration::hours(1),
            now: Utc::now(),
        })
        .unwrap();

    let mut intent = FrozenIntentV2 {
        schema_version: FROZEN_INTENT_SCHEMA_VERSION,
        id: IntentId::new(),
        task_run_id: run.id,
        task_state_version: run.state_version,
        task_state_digest: run.state_digest.clone(),
        organization_id: org,
        project_id: None,
        principal_id: principal,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: "read".into(),
        resource: "doc:1".into(),
        audience: "https://rs.example".into(),
        canonical_arguments: json!({"tenant": "A"}),
        body_hash: None,
        nonce: "n1".into(),
        idempotency_key: "idem-mut".into(),
        issued_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(5),
        intent_digest: String::new(),
    }
    .with_computed_digest()
    .unwrap();

    let authorized_digest = intent.intent_digest.clone();
    // Mutate after authorization snapshot — digest must fail.
    intent.canonical_arguments = json!({"tenant": "B"});
    assert!(intent.assert_digest().is_err());
    assert_ne!(intent.compute_digest().unwrap(), authorized_digest);
    let _ = sample_grant(org, principal);
}
