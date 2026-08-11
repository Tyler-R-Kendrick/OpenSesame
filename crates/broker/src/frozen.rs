//! Authorize-and-execute path that never accepts a second mutable parameter blob.

use chrono::Utc;
use opensesame_authz::{AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject};
use opensesame_connector_host::InvokeRequest;
use opensesame_domain::*;
use opensesame_task_access::{TaskAccessEngine, TaskStore};
use serde_json::{json, Value};

use crate::{Broker, FinishReceiptParts};

/// Authority-bearing invoke: frozen intent bytes only (no separate parameters).
pub struct FrozenInvokeInput {
    pub intent: FrozenIntentV2,
    pub grant: Grant,
    pub subject: String,
    pub connection_policy_id: String,
    /// Required capability for the operation within the task current set.
    pub required_capability: Capability,
}

/// Every narrowing field a grant carries, checked against the intent it is being
/// used to authorize.
///
/// The organization was already compared; everything else on the grant was
/// ignored. A grant issued to one principal, for one actor, one project and one
/// connection therefore authorized any intent in the organization whose action,
/// resource and audience happened to fit — which is the whole of what the grant
/// was narrowed to say it could not do (ADR 0027: one effective authority).
///
/// `None` on the grant means unscoped in that dimension. `Some` means the intent
/// must name the same thing; an intent that names nothing does not satisfy a
/// grant that names something.
pub fn assert_grant_covers_frozen_intent(
    grant: &Grant,
    intent: &FrozenIntentV2,
) -> Result<(), DomainError> {
    let denied = |what: &str| {
        Err(DomainError::AuthorizationDenied(format!(
            "grant does not cover this intent: {what}"
        )))
    };
    if intent.organization_id != grant.organization_id {
        return Err(DomainError::OrganizationMismatch);
    }
    if grant.beneficiary_principal_id != intent.principal_id {
        return denied("beneficiary principal");
    }
    if let Some(project) = grant.project_id {
        if intent.project_id != Some(project) {
            return denied("project");
        }
    }
    if let Some(actor) = grant.actor_id {
        if intent.actor_id != actor {
            return denied("actor");
        }
    }
    if let Some(instance) = grant.actor_instance_id {
        if intent.actor_instance_id != Some(instance) {
            return denied("actor instance");
        }
    }
    if let Some(client) = grant.client_id {
        if intent.client_id != Some(client) {
            return denied("client");
        }
    }
    if let Some(connection) = grant.connection_id {
        if intent.connection_id != Some(connection) {
            return denied("connection");
        }
    }
    Ok(())
}

impl Broker {
    /// Persist digest → authorize that digest → execute canonical arguments from the same intent.
    pub async fn invoke_frozen<S: TaskStore>(
        &self,
        tasks: &TaskAccessEngine<S>,
        input: FrozenInvokeInput,
    ) -> anyhow::Result<InvocationReceipt> {
        let now = Utc::now();
        input.intent.assert_fresh(now)?;
        input.grant.assert_active(now)?;

        // Recompute and bind digest; reject caller-supplied mismatches.
        let intent = input.intent.clone().with_computed_digest()?;
        intent.assert_digest()?;

        assert_grant_covers_frozen_intent(&input.grant, &intent)?;

        let run = tasks.assert_capability(
            intent.task_run_id,
            &input.required_capability,
            intent.task_state_version,
            now,
        )?;
        if run.state_digest != intent.task_state_digest {
            return Err(DomainError::TaskStateVersionMismatch {
                expected: intent.task_state_version,
                actual: run.state_version,
            }
            .into());
        }
        tasks.assert_ceiling_unchanged(&run)?;

        if !self.db.authority_quorum_ok().await? {
            return Err(
                DomainError::AuthorityUnavailable(AvailabilityClass::A3ExternalSideEffect).into(),
            );
        }

        // Compatibility: store a V1 projection for idempotency tables that expect Intent.
        let legacy = Intent {
            id: intent.id,
            organization_id: intent.organization_id,
            project_id: intent.project_id,
            principal_id: intent.principal_id,
            actor_id: intent.actor_id,
            actor_instance_id: intent.actor_instance_id,
            client_id: intent.client_id,
            operator_id: intent.operator_id,
            connection_id: intent.connection_id,
            operation: intent.operation.clone(),
            resource: intent.resource.clone(),
            audience: intent.audience.clone(),
            normalized_parameters_hash: Intent::parameters_hash(&intent.canonical_arguments)?,
            body_hash: intent.body_hash.clone(),
            nonce: intent.nonce.clone(),
            idempotency_key: intent.idempotency_key.clone(),
            issued_at: intent.issued_at,
            expires_at: intent.expires_at,
            parent_invocation_id: None,
            delegation_chain: vec![],
            proof: DetachedProof {
                algorithm: "task-bound".into(),
                key_thumbprint: "task".into(),
                signature: intent.intent_digest.clone(),
            },
        };

        let existing = self
            .db
            .find_intent_by_idempotency(&legacy.organization_id, &legacy.idempotency_key)
            .await?;
        if existing.is_some() {
            if let Some(prior_receipt) = self
                .db
                .find_receipt_by_idempotency(&legacy.organization_id, &legacy.idempotency_key)
                .await?
            {
                return Ok(prior_receipt);
            }
            anyhow::bail!("idempotency conflict: prior frozen intent has no receipt yet");
        }
        self.db.insert_intent(&legacy).await?;

        let mut inv = Invocation {
            id: InvocationId::new(),
            intent_id: intent.id,
            state: InvocationState::Received,
            attempt: 1,
            lease_owner: None,
            lease_expires_at: None,
            created_at: now,
            updated_at: now,
        };
        inv.transition(InvocationState::Authorizing, now)?;

        let authz_req = AuthZenRequest {
            subject: AuthZenSubject {
                type_: "user".into(),
                id: input.subject.clone(),
                properties: json!({
                    "assurance": input.grant.constraints.required_assurance,
                    "task_run_id": intent.task_run_id.to_string(),
                    "task_state_version": intent.task_state_version,
                }),
            },
            action: AuthZenAction {
                name: intent.operation.clone(),
            },
            resource: AuthZenResource {
                type_: "connector_operation".into(),
                id: intent.resource.clone(),
            },
            context: json!({
                "connection_id": input.connection_policy_id,
                "audience": intent.audience,
                "intent_digest": intent.intent_digest,
                "task_state_digest": intent.task_state_digest,
            }),
        };

        let decision = self.policy.decide(
            &authz_req,
            Some(&input.grant),
            AvailabilityClass::A3ExternalSideEffect,
        )?;
        if !decision.decision {
            inv.transition(InvocationState::Denied, Utc::now())?;
            self.db.insert_invocation(&inv).await?;
            let receipt = self.finish_frozen_receipt(
                &intent,
                &inv,
                FinishReceiptParts {
                    decision_id: &decision.decision_id,
                    policy_digest: &decision.policy_version_digest,
                    outcome: ReceiptOutcome::Denied,
                    summary: json!({"reason": decision.context}),
                    ext: None,
                    connector_digest: self.host.component_digest(&input.connection_policy_id),
                },
            )?;
            self.db.insert_receipt(&receipt).await?;
            return Ok(receipt);
        }

        inv.transition(InvocationState::Authorized, Utc::now())?;
        inv.transition(InvocationState::Leased, Utc::now())?;
        inv.lease_owner = Some("worker-local".into());
        inv.transition(InvocationState::Executing, Utc::now())?;
        self.db.insert_invocation(&inv).await?;

        // Execute ONLY from frozen canonical_arguments — never a second parameter map.
        let params_digest = Intent::parameters_hash(&intent.canonical_arguments)?;
        let result = self.host.invoke(
            &input.connection_policy_id,
            &InvokeRequest {
                operation: intent.operation.clone(),
                resource: intent.resource.clone(),
                audience: intent.audience.clone(),
                parameters: intent.canonical_arguments.clone(),
                parameters_digest: params_digest,
                authorized_operation: intent.operation.clone(),
                invoke_level: Some(1),
            },
        );

        let (outcome, summary, ext) = match result {
            Ok(r) => {
                inv.transition(InvocationState::Succeeded, Utc::now())?;
                (
                    ReceiptOutcome::Succeeded,
                    r.safe_summary,
                    r.external_request_digest,
                )
            }
            Err(e) => {
                inv.transition(InvocationState::Failed, Utc::now())?;
                (
                    ReceiptOutcome::Failed,
                    json!({"error": e.to_string()}),
                    None,
                )
            }
        };

        let receipt = self.finish_frozen_receipt(
            &intent,
            &inv,
            FinishReceiptParts {
                decision_id: &decision.decision_id,
                policy_digest: &decision.policy_version_digest,
                outcome,
                summary,
                ext,
                connector_digest: self.host.component_digest(&input.connection_policy_id),
            },
        )?;
        assert!(receipt.assert_no_secret_leak());
        self.db.insert_receipt(&receipt).await?;
        Ok(receipt)
    }

    fn finish_frozen_receipt(
        &self,
        intent: &FrozenIntentV2,
        inv: &Invocation,
        parts: FinishReceiptParts<'_>,
    ) -> anyhow::Result<InvocationReceipt> {
        let mut receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: inv.id,
            intent_digest: intent.intent_digest.clone(),
            principal_id: intent.principal_id,
            organization_id: Some(intent.organization_id),
            actor_id: intent.actor_id,
            actor_instance_id: intent.actor_instance_id,
            client_id: intent.client_id,
            operator_id: intent.operator_id,
            delegation_chain: vec![],
            connection_id: intent.connection_id,
            operation: intent.operation.clone(),
            resource: intent.resource.clone(),
            policy_decision_id: parts.decision_id.into(),
            policy_version_digest: parts.policy_digest.into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: parts.connector_digest.map(str::to_owned),
            external_request_digest: parts.ext,
            external_response_digest: None,
            started_at: inv.created_at,
            completed_at: Utc::now(),
            outcome: parts.outcome,
            safe_result_summary: Some(parts.summary),
            authority_key_id: String::new(),
            signature: String::new(),
            receipt_schema_version: 3,
            task_run_id: Some(intent.task_run_id),
            task_state_version: Some(intent.task_state_version),
            task_state_digest: Some(intent.task_state_digest.clone()),
        };
        // Attach task provenance in safe summary (not secrets).
        if let Some(summary) = receipt.safe_result_summary.as_mut() {
            if let Some(obj) = summary.as_object_mut() {
                obj.insert(
                    "task_run_id".into(),
                    Value::String(intent.task_run_id.to_string()),
                );
                obj.insert(
                    "task_state_version".into(),
                    json!(intent.task_state_version),
                );
            }
        }
        Ok(self.signer.sign_receipt(receipt)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use opensesame_audit::ReceiptSigner;
    use opensesame_authz::PolicyEngine;
    use opensesame_connector_host::HostRuntime;
    use opensesame_domain::{AuthorityContext, AuthorityContextMode, ResourceSelector};
    use opensesame_storage::Db;
    use opensesame_task_access::{InMemoryTaskStore, StartTaskParams};

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
                budgets: Default::default(),
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

        type Narrowing = (&'static str, fn(&mut Grant));
        let narrowings: [Narrowing; 4] = [
            ("actor", |g| g.actor_id = Some(ActorId::new())),
            ("actor instance", |g| {
                g.actor_instance_id = Some(ActorInstanceId::new())
            }),
            ("client", |g| g.client_id = Some(ClientId::new())),
            ("connection", |g| {
                g.connection_id = Some(ConnectionId::new())
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
}
