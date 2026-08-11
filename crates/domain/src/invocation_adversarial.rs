#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::Utc;

    #[test]
    fn illegal_transitions_rejected() {
        let now = Utc::now();
        let mut inv = Invocation {
            id: InvocationId::new(),
            intent_id: IntentId::new(),
            state: InvocationState::Succeeded,
            attempt: 1,
            lease_owner: None,
            lease_expires_at: None,
            created_at: now,
            updated_at: now,
        };
        assert!(inv.transition(InvocationState::Executing, now).is_err());
        assert!(inv.transition(InvocationState::Received, now).is_err());
    }

    #[test]
    fn denied_is_terminal() {
        assert!(!InvocationState::Denied.can_transition(InvocationState::Authorized));
        assert!(!InvocationState::Cancelled.can_transition(InvocationState::Executing));
        assert!(!InvocationState::Expired.can_transition(InvocationState::Received));
    }

    #[test]
    fn approval_path() {
        assert!(InvocationState::Authorizing.can_transition(InvocationState::AwaitingApproval));
        assert!(InvocationState::AwaitingApproval.can_transition(InvocationState::Authorized));
        assert!(InvocationState::AwaitingApproval.can_transition(InvocationState::Denied));
    }

    #[test]
    fn lease_return_path() {
        assert!(InvocationState::Leased.can_transition(InvocationState::Authorized));
        assert!(InvocationState::Leased.can_transition(InvocationState::Executing));
    }

    #[test]
    fn receipt_secret_matrix() {
        let banned = [
            "refresh_token",
            "access_token",
            "password",
            "private_key",
            "authorization_code",
            "device_code",
            "claim_token",
            "client_secret",
        ];
        for key in banned {
            let r = InvocationReceipt {
                id: ReceiptId::new(),
                invocation_id: InvocationId::new(),
                intent_digest: "sha256:x".into(),
                principal_id: PrincipalId::new(),
                organization_id: None,
                actor_id: ActorId::new(),
                actor_instance_id: None,
                client_id: None,
                operator_id: None,
                delegation_chain: vec![],
                connection_id: None,
                operation: "x".into(),
                resource: "y".into(),
                policy_decision_id: "d".into(),
                policy_version_digest: "p".into(),
                approval_id: None,
                credential_handle_id: None,
                connector_component_digest: None,
                external_request_digest: None,
                external_response_digest: None,
                started_at: Utc::now(),
                completed_at: Utc::now(),
                outcome: ReceiptOutcome::Succeeded,
                safe_result_summary: Some(serde_json::json!({ key: "LEAK" })),
                authority_key_id: "k".into(),
                signature: "s".into(),
                receipt_schema_version: 1,
                task_run_id: None,
                task_state_version: None,
                task_state_digest: None,
            };
            assert!(!r.assert_no_secret_leak(), "must detect {key}");
        }
    }
}
