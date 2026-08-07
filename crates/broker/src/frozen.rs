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

        if intent.organization_id != input.grant.organization_id {
            return Err(DomainError::OrganizationMismatch.into());
        }

        let run = tasks.assert_capability(
            intent.task_run_id,
            &input.required_capability,
            intent.task_state_version,
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
        let result = self.host.invoke_mock(&InvokeRequest {
            operation: intent.operation.clone(),
            resource: intent.resource.clone(),
            audience: intent.audience.clone(),
            parameters: intent.canonical_arguments.clone(),
            parameters_digest: params_digest,
            authorized_operation: intent.operation.clone(),
            invoke_level: Some(1),
        });

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
            connector_component_digest: Some("sha256:mock-connector".into()),
            external_request_digest: parts.ext,
            external_response_digest: None,
            started_at: inv.created_at,
            completed_at: Utc::now(),
            outcome: parts.outcome,
            safe_result_summary: Some(parts.summary),
            authority_key_id: String::new(),
            signature: String::new(),
            receipt_schema_version: 2,
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
    use opensesame_domain::{AuthorityContext, AuthorityContextMode, ResourceSelector};
    use opensesame_task_access::{InMemoryTaskStore, StartTaskParams};

    #[allow(dead_code)]
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
