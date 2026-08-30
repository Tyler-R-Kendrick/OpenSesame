mod frozen;

pub use frozen::{assert_grant_covers_frozen_intent, FrozenInvokeInput};

use chrono::Utc;
use opensesame_audit::ReceiptSigner;
use opensesame_authz::{
    AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject, PolicyEngine,
};
use opensesame_connector_host::{HostRuntime, InvokeRequest};
use opensesame_domain::{
    AvailabilityClass, DomainError, Grant, Intent, Invocation, InvocationId, InvocationReceipt,
    InvocationState, ReceiptId, ReceiptOutcome,
};
use opensesame_storage::Db;
use serde_json::{json, Value};

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
    async fn prior_receipt(
        &self,
        intent: &Intent,
        conflict_message: &str,
    ) -> anyhow::Result<Option<InvocationReceipt>> {
        let existing = self
            .db
            .find_intent_by_idempotency(&intent.organization_id, &intent.idempotency_key)
            .await?;
        if existing.is_none() {
            return Ok(None);
        }
        if let Some(receipt) = self
            .db
            .find_receipt_by_idempotency(&intent.organization_id, &intent.idempotency_key)
            .await?
        {
            return Ok(Some(receipt));
        }
        anyhow::bail!(conflict_message.to_string())
    }

    fn begin_invocation(
        intent_id: opensesame_domain::IntentId,
        now: chrono::DateTime<Utc>,
    ) -> anyhow::Result<Invocation> {
        let mut invocation = Invocation {
            id: InvocationId::new(),
            intent_id,
            state: InvocationState::Received,
            attempt: 1,
            lease_owner: None,
            lease_expires_at: None,
            created_at: now,
            updated_at: now,
        };
        invocation.transition(InvocationState::Authorizing, now)?;
        Ok(invocation)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation, authorization, execution, or durable
    /// receipt persistence fails.
    pub async fn invoke(&self, input: InvokeInput) -> anyhow::Result<InvocationReceipt> {
        let request = InvokeRequest {
            operation: input.intent.operation.clone(),
            resource: input.intent.resource.clone(),
            audience: input.intent.audience.clone(),
            parameters: input.parameters.clone(),
            parameters_digest: input.intent.normalized_parameters_hash.clone(),
            authorized_operation: input.intent.operation.clone(),
            invoke_level: Some(1),
            connection_ref: input.connection_policy_id.clone(),
        };
        let connection_policy_id = input.connection_policy_id.clone();
        self.invoke_with(input, || async {
            self.host.invoke(&connection_policy_id, &request)
        })
        .await
    }

    /// Run an invocation with an authority-owned asynchronous executor.
    ///
    /// The closure is called only after freshness, grant, policy, quorum, and
    /// idempotency checks pass. This is the path for credentialed network
    /// connectors, whose egress cannot run inside the synchronous component
    /// host.
    ///
    /// # Errors
    ///
    /// Returns an error when validation, authorization, execution, or durable
    /// receipt persistence fails.
    pub async fn invoke_with<E, F>(
        &self,
        input: InvokeInput,
        execute: E,
    ) -> anyhow::Result<InvocationReceipt>
    where
        E: FnOnce() -> F,
        F: std::future::Future<
            Output = Result<
                opensesame_connector_host::InvokeResult,
                opensesame_connector_host::HostError,
            >,
        >,
    {
        let now = Utc::now();
        input.intent.assert_fresh(now)?;
        input.grant.assert_active(now)?;

        if input.intent.organization_id != input.grant.organization_id {
            return Err(DomainError::OrganizationMismatch.into());
        }

        if !self.db.authority_quorum_ok().await? {
            return Err(
                DomainError::AuthorityUnavailable(AvailabilityClass::A3ExternalSideEffect).into(),
            );
        }

        if let Some(receipt) = self
            .prior_receipt(
                &input.intent,
                "idempotency conflict: prior intent has no receipt yet",
            )
            .await?
        {
            return Ok(receipt);
        }
        self.db.insert_intent(&input.intent).await?;

        let expected = Intent::parameters_hash(&input.parameters)?;
        if expected != input.intent.normalized_parameters_hash {
            anyhow::bail!("parameter digest mismatch");
        }

        let mut inv = Self::begin_invocation(input.intent.id, now)?;

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
                // The durable connection id, so a delegated child grant can be
                // its own eligibility for exactly the connection it names.
                "connection_uuid": input.intent.connection_id.map(|c| c.to_string()),
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

        self.execute_authorized(
            &input,
            inv,
            &decision.decision_id,
            &decision.policy_version_digest,
            execute,
        )
        .await
    }

    async fn execute_authorized<E, F>(
        &self,
        input: &InvokeInput,
        mut invocation: Invocation,
        decision_id: &str,
        policy_digest: &str,
        execute: E,
    ) -> anyhow::Result<InvocationReceipt>
    where
        E: FnOnce() -> F,
        F: std::future::Future<
            Output = Result<
                opensesame_connector_host::InvokeResult,
                opensesame_connector_host::HostError,
            >,
        >,
    {
        invocation.transition(InvocationState::Authorized, Utc::now())?;
        invocation.transition(InvocationState::Leased, Utc::now())?;
        invocation.lease_owner = Some("worker-local".into());
        invocation.transition(InvocationState::Executing, Utc::now())?;
        self.db.insert_invocation(&invocation).await?;

        let result = execute().await;

        let (outcome, summary, ext) = match result {
            Ok(r) => {
                invocation.transition(InvocationState::Succeeded, Utc::now())?;
                (
                    ReceiptOutcome::Succeeded,
                    r.safe_summary,
                    r.external_request_digest,
                )
            }
            Err(e) => {
                invocation.transition(InvocationState::Failed, Utc::now())?;
                // Connector errors echo upstream URLs and headers; receipts are
                // durable and readable, so the text is redacted before it lands.
                let msg = opensesame_redaction::redact_text(&e.to_string());
                (ReceiptOutcome::Failed, json!({"error": msg}), None)
            }
        };

        let receipt = self.finish_receipt(
            input,
            &invocation,
            FinishReceiptParts {
                decision_id,
                policy_digest,
                outcome,
                summary,
                ext,
                connector_digest: self.host.component_digest(&input.connection_policy_id),
            },
        )?;
        // Fail the invocation instead of panicking the process: a summary that
        // trips the leak check must never be persisted, but it is not a crash.
        if !receipt.assert_no_secret_leak() {
            anyhow::bail!("receipt summary rejected by secret-leak check");
        }
        self.db.insert_receipt(&receipt).await?;
        Ok(receipt)
    }

    fn finish_receipt(
        &self,
        input: &InvokeInput,
        inv: &Invocation,
        parts: FinishReceiptParts<'_>,
    ) -> anyhow::Result<InvocationReceipt> {
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: inv.id,
            intent_digest: input.intent.digest()?,
            principal_id: input.intent.principal_id,
            organization_id: Some(input.intent.organization_id),
            actor_id: input.intent.actor_id,
            actor_instance_id: input.intent.actor_instance_id,
            client_id: input.intent.client_id,
            operator_id: input.intent.operator_id,
            delegation_chain: input.intent.delegation_chain.clone(),
            connection_id: input.intent.connection_id,
            operation: input.intent.operation.clone(),
            resource: input.intent.resource.clone(),
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
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        Ok(self.signer.sign_receipt(receipt)?)
    }
}

pub(crate) struct FinishReceiptParts<'a> {
    decision_id: &'a str,
    policy_digest: &'a str,
    outcome: ReceiptOutcome,
    summary: Value,
    ext: Option<String>,
    connector_digest: Option<&'a str>,
}
