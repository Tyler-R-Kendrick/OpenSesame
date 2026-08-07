use chrono::Utc;
use opensesame_audit::ReceiptSigner;
use opensesame_authz::{AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject, PolicyEngine};
use opensesame_connector_host::{HostRuntime, InvokeRequest};
use opensesame_domain::*;
use opensesame_storage::Db;
use serde_json::{json, Value};
use std::io::Write;

// #region agent log
fn agent_dbg(hypothesis_id: &str, location: &str, message: &str, data: Value) {
    let payload = json!({
        "sessionId": "7aa2f5",
        "runId": std::env::var("OPENSESAME_DEBUG_RUN").unwrap_or_else(|_| "battle-1".into()),
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": Utc::now().timestamp_millis(),
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/home/codex/.herdr/worktrees/opensesame/.cursor/debug-7aa2f5.log")
    {
        let _ = writeln!(f, "{payload}");
    }
}
// #endregion

pub struct Broker {
    pub db: Db,
    pub policy: PolicyEngine,
    pub host: HostRuntime,
    pub signer: ReceiptSigner,
}

pub struct InvokeInput {
    pub intent: Intent,
    pub grant: Grant,
    pub subject: String,
    pub connection_policy_id: String,
    pub parameters: Value,
}

impl Broker {
    pub async fn invoke(&self, input: InvokeInput) -> anyhow::Result<InvocationReceipt> {
        let now = Utc::now();
        // #region agent log
        agent_dbg(
            "B",
            "broker.rs:invoke:entry",
            "invoke entry org checks",
            json!({
                "intent_org": input.intent.organization_id.to_string(),
                "grant_org": input.grant.organization_id.to_string(),
                "org_match": input.intent.organization_id == input.grant.organization_id,
                "idempotency_key_len": input.intent.idempotency_key.len(),
                "operation": input.intent.operation,
                "grant_revoked": input.grant.revoked_at.is_some(),
                "grant_expired": now >= input.grant.constraints.expires_at,
            }),
        );
        // #endregion
        input.intent.assert_fresh(now)?;
        input.grant.assert_active(now)?;

        if input.intent.organization_id != input.grant.organization_id {
            // #region agent log
            agent_dbg(
                "B",
                "broker.rs:invoke:org_mismatch",
                "rejecting cross-org grant/intent",
                json!({
                    "intent_org": input.intent.organization_id.to_string(),
                    "grant_org": input.grant.organization_id.to_string(),
                }),
            );
            // #endregion
            return Err(DomainError::OrganizationMismatch.into());
        }

        if !self.db.authority_quorum_ok().await? {
            // #region agent log
            agent_dbg(
                "C",
                "broker.rs:invoke:quorum",
                "authority quorum unavailable",
                json!({"class": "A3"}),
            );
            // #endregion
            return Err(DomainError::AuthorityUnavailable(AvailabilityClass::A3ExternalSideEffect).into());
        }

        let existing = self
            .db
            .find_intent_by_idempotency(&input.intent.organization_id, &input.intent.idempotency_key)
            .await?;
        if let Some(prior_intent) = existing {
            if let Some(prior_receipt) = self
                .db
                .find_receipt_by_idempotency(
                    &input.intent.organization_id,
                    &input.intent.idempotency_key,
                )
                .await?
            {
                // #region agent log
                agent_dbg(
                    "A",
                    "broker.rs:invoke:idempotency",
                    "returning prior receipt",
                    json!({
                        "existing_found": true,
                        "existing_intent_id": prior_intent.id.to_string(),
                        "new_intent_id": input.intent.id.to_string(),
                        "will_reexecute": false,
                        "prior_receipt_id": prior_receipt.id.to_string(),
                    }),
                );
                // #endregion
                return Ok(prior_receipt);
            }
            // #region agent log
            agent_dbg(
                "A",
                "broker.rs:invoke:idempotency",
                "idempotent intent exists without receipt — conflict",
                json!({
                    "existing_found": true,
                    "existing_intent_id": prior_intent.id.to_string(),
                    "will_reexecute": false,
                }),
            );
            // #endregion
            anyhow::bail!("idempotency conflict: prior intent has no receipt yet");
        }
        // #region agent log
        agent_dbg(
            "A",
            "broker.rs:invoke:idempotency",
            "idempotency lookup",
            json!({
                "existing_found": false,
                "existing_intent_id": null,
                "new_intent_id": input.intent.id.to_string(),
                "will_reexecute": true,
            }),
        );
        // #endregion
        self.db.insert_intent(&input.intent).await?;

        let expected = Intent::parameters_hash(&input.parameters)?;
        if expected != input.intent.normalized_parameters_hash {
            anyhow::bail!("parameter digest mismatch");
        }

        let mut inv = Invocation {
            id: InvocationId::new(),
            intent_id: input.intent.id,
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
                properties: json!({"assurance": input.grant.constraints.required_assurance}),
            },
            action: AuthZenAction {
                name: input.intent.operation.clone(),
            },
            resource: AuthZenResource {
                type_: "connector_operation".into(),
                id: input.intent.resource.clone(),
            },
            context: json!({
                "connection_id": input.connection_policy_id,
                "audience": input.intent.audience,
                "parameters_digest": input.intent.normalized_parameters_hash,
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
            let receipt = self.finish_receipt(
                &input,
                &inv,
                &decision.decision_id,
                &decision.policy_version_digest,
                ReceiptOutcome::Denied,
                json!({"reason": decision.context}),
                None,
            )?;
            self.db.insert_receipt(&receipt).await?;
            return Ok(receipt);
        }

        inv.transition(InvocationState::Authorized, Utc::now())?;
        inv.transition(InvocationState::Leased, Utc::now())?;
        inv.lease_owner = Some("worker-local".into());
        inv.transition(InvocationState::Executing, Utc::now())?;
        self.db.insert_invocation(&inv).await?;

        let result = self.host.invoke_mock(&InvokeRequest {
            operation: input.intent.operation.clone(),
            resource: input.intent.resource.clone(),
            audience: input.intent.audience.clone(),
            parameters: input.parameters.clone(),
            parameters_digest: input.intent.normalized_parameters_hash.clone(),
            authorized_operation: input.intent.operation.clone(),
            invoke_level: Some(1),
        });

        let (outcome, summary, ext) = match result {
            Ok(r) => {
                inv.transition(InvocationState::Succeeded, Utc::now())?;
                (ReceiptOutcome::Succeeded, r.safe_summary, r.external_request_digest)
            }
            Err(e) => {
                inv.transition(InvocationState::Failed, Utc::now())?;
                (ReceiptOutcome::Failed, json!({"error": e.to_string()}), None)
            }
        };

        let receipt = self.finish_receipt(
            &input,
            &inv,
            &decision.decision_id,
            &decision.policy_version_digest,
            outcome,
            summary,
            ext,
        )?;
        assert!(receipt.assert_no_secret_leak());
        self.db.insert_receipt(&receipt).await?;
        // #region agent log
        agent_dbg(
            "A",
            "broker.rs:invoke:exit",
            "invoke completed new receipt",
            json!({
                "receipt_id": receipt.id.to_string(),
                "invocation_id": receipt.invocation_id.to_string(),
                "intent_id": input.intent.id.to_string(),
                "outcome": format!("{:?}", receipt.outcome),
            }),
        );
        // #endregion
        Ok(receipt)
    }

    fn finish_receipt(
        &self,
        input: &InvokeInput,
        inv: &Invocation,
        decision_id: &str,
        policy_digest: &str,
        outcome: ReceiptOutcome,
        summary: Value,
        ext: Option<String>,
    ) -> anyhow::Result<InvocationReceipt> {
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: inv.id,
            intent_digest: input.intent.digest()?,
            principal_id: input.intent.principal_id,
            actor_id: input.intent.actor_id,
            actor_instance_id: input.intent.actor_instance_id,
            client_id: input.intent.client_id,
            operator_id: input.intent.operator_id,
            delegation_chain: input.intent.delegation_chain.clone(),
            connection_id: input.intent.connection_id,
            operation: input.intent.operation.clone(),
            resource: input.intent.resource.clone(),
            policy_decision_id: decision_id.into(),
            policy_version_digest: policy_digest.into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: Some("sha256:mock-connector".into()),
            external_request_digest: ext,
            external_response_digest: None,
            started_at: inv.created_at,
            completed_at: Utc::now(),
            outcome,
            safe_result_summary: Some(summary),
            authority_key_id: String::new(),
            signature: String::new(),
        };
        Ok(self.signer.sign_receipt(receipt)?)
    }
}
