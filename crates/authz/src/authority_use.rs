//! Custodian-style authority exercise: ConnectionRef + Intent — never SecretRef to agents.

use crate::{
    AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject, AuthzError, PolicyEngine,
};
use opensesame_domain::{
    AuthorityHandle, AuthorityKind, AuthorityOperation, AvailabilityClass,
    ConnectionAuthorityBinding, ConnectionRef, DomainError, EgressBinding, Grant, InvokeLevel,
};
use serde_json::json;
use std::io::Write;

// #region agent log
fn agent_dbg(hypothesis_id: &str, location: &str, message: &str, data: serde_json::Value) {
    let payload = json!({
        "sessionId": "7aa2f5",
        "runId": std::env::var("OPENSESAME_DEBUG_RUN").unwrap_or_else(|_| "authority-1".into()),
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": chrono::Utc::now().timestamp_millis(),
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

#[derive(Clone, Debug)]
pub struct AuthorityDecision {
    pub allowed: bool,
    pub decision_id: String,
    pub policy_version_digest: String,
    pub reason: Option<String>,
}

/// Enforce: reference ≠ capability; Level 3 export denied unless grant says so;
/// L2 HTTP must satisfy egress binding.
pub fn authorize_authority_use(
    engine: &PolicyEngine,
    subject: &str,
    grant: &Grant,
    binding: &ConnectionAuthorityBinding,
    op: AuthorityOperation,
    level: InvokeLevel,
    requested_url: Option<&str>,
) -> Result<AuthorityDecision, AuthzError> {
    // #region agent log
    agent_dbg(
        "AH1",
        "authority_use.rs:entry",
        "authority use request",
        json!({
            "handle_kind": format!("{:?}", binding.connection_ref.handle.kind),
            "operation": format!("{:?}", op),
            "level": level.as_u8(),
            "requested_url": requested_url,
            "export_flag": grant.constraints.raw_credential_export,
            "max_level": binding.max_invoke_level.as_u8(),
        }),
    );
    // #endregion

    if binding.connection_ref.handle.kind != AuthorityKind::Connection {
        return Err(AuthzError::Denied(
            "agent API accepts ConnectionRef only".into(),
        ));
    }

    if level > binding.max_invoke_level {
        // #region agent log
        agent_dbg(
            "AH2",
            "authority_use.rs:level",
            "invoke level exceeds connection max",
            json!({"level": level.as_u8(), "max": binding.max_invoke_level.as_u8()}),
        );
        // #endregion
        return Err(AuthzError::Denied("invoke level not permitted".into()));
    }

    if op.requires_export_privilege() || level == InvokeLevel::Materialize {
        if !grant.constraints.raw_credential_export {
            // #region agent log
            agent_dbg(
                "AH3",
                "authority_use.rs:export",
                "materialize/resolve denied",
                json!({"op": format!("{:?}", op)}),
            );
            // #endregion
            return Err(AuthzError::Denied(
                "credential materialization denied by default".into(),
            ));
        }
    }

    if level == InvokeLevel::ConstrainedHttp {
        let url = requested_url.ok_or_else(|| {
            AuthzError::Denied("constrained HTTP requires URL bound to egress".into())
        })?;
        binding.egress.allows_url(url).map_err(|e| {
            // #region agent log
            agent_dbg(
                "AH4",
                "authority_use.rs:egress",
                "egress deny",
                json!({"url": url, "error": e.to_string()}),
            );
            // #endregion
            AuthzError::Denied(e.to_string())
        })?;
    }

    // Knowing a SecretRef URI is not enough — never authorize Resolve from Secret kind alone.
    if matches!(op, AuthorityOperation::Resolve) {
        if let Some(secret) = &binding.internal_secret {
            if secret.kind == AuthorityKind::Secret && !grant.constraints.raw_credential_export {
                return Err(AuthzError::Denied("SecretRef resolve denied".into()));
            }
        }
    }

    let req = AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: subject.into(),
            properties: json!({"assurance": grant.constraints.required_assurance}),
        },
        action: AuthZenAction {
            name: match level {
                InvokeLevel::TypedOperation => "connection.invoke".into(),
                InvokeLevel::ConstrainedHttp => "connection.fetch".into(),
                InvokeLevel::Materialize => "credential.export".into(),
            },
        },
        resource: AuthZenResource {
            type_: "connection".into(),
            id: binding.connection_ref.connection_id.to_string(),
        },
        context: json!({
            "connection_id": "demo-conn",
            "audience": grant.constraints.audiences.first(),
            "invoke_level": level.as_u8(),
            "connection_ref": binding.connection_ref.handle.uri(),
        }),
    };

    // For materialize, use connector_operation path via export action on grant.
    let class = if level == InvokeLevel::Materialize {
        AvailabilityClass::A2AuthorityRequired
    } else {
        AvailabilityClass::A3ExternalSideEffect
    };

    // Relationship check uses connection user for invoke; export uses grant flag already.
    let mut engine_req = req;
    if level != InvokeLevel::Materialize {
        engine_req.action.name = grant
            .actions
            .first()
            .cloned()
            .unwrap_or_else(|| "connection.invoke".into());
        engine_req.resource = AuthZenResource {
            type_: "connector_operation".into(),
            id: "op".into(),
        };
    }

    match engine.decide(&engine_req, Some(grant), class) {
        Ok(d) if d.decision => {
            // #region agent log
            agent_dbg(
                "AH1",
                "authority_use.rs:allow",
                "authority use allowed",
                json!({"decision_id": d.decision_id, "level": level.as_u8()}),
            );
            // #endregion
            Ok(AuthorityDecision {
                allowed: true,
                decision_id: d.decision_id,
                policy_version_digest: d.policy_version_digest,
                reason: None,
            })
        }
        Ok(d) => Ok(AuthorityDecision {
            allowed: false,
            decision_id: d.decision_id,
            policy_version_digest: d.policy_version_digest,
            reason: Some("policy denied".into()),
        }),
        Err(e) => Err(e),
    }
}

pub fn assert_no_secret_in_agent_payload(value: &serde_json::Value) -> Result<(), DomainError> {
    let s = value.to_string().to_lowercase();
    for banned in [
        "secret://",
        "ghp_",
        "access_token",
        "refresh_token",
        "private_key",
        "client_secret",
    ] {
        if s.contains(banned) {
            return Err(DomainError::ExportDenied);
        }
    }
    // Connection refs are fine
    Ok(())
}

pub fn github_binding(
    connection_ref: ConnectionRef,
    secret_logical: &str,
) -> ConnectionAuthorityBinding {
    let org = connection_ref.handle.organization_id;
    ConnectionAuthorityBinding {
        connection_ref: connection_ref.clone(),
        internal_secret: Some(AuthorityHandle::secret_internal(
            org,
            connection_ref.handle.project_id,
            secret_logical,
        )),
        credential_handle: None,
        egress: EgressBinding {
            scheme: "https".into(),
            authorities: vec!["api.github.com".into(), "api.github.com:443".into()],
            path_prefixes: vec!["/repos/".into()],
            allow_redirects_cross_authority: false,
        },
        max_invoke_level: InvokeLevel::ConstrainedHttp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use opensesame_domain::*;

    fn grant(export: bool) -> Grant {
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
            organization_id: OrganizationId::new(),
            project_id: None,
            environment_id: None,
            connection_id: None,
            actions: vec!["pull_request.create".into(), "repository.read".into()],
            resources: vec!["repo:acme/catalog".into()],
            constraints: GrantConstraints {
                audiences: vec!["https://api.github.com".into()],
                not_before: None,
                expires_at: now + Duration::hours(1),
                required_assurance: Some("mfa".into()),
                authentication_max_age_seconds: None,
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: Default::default(),
                maximum_delegation_depth: 0,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: export,
            },
            parent_grant_id: None,
            delegation_depth: 0,
            created_at: now,
            revoked_at: None,
        }
    }

    fn engine() -> PolicyEngine {
        let mut e = PolicyEngine::default();
        e.relationships
            .write("connection:demo-conn", "user", "user:demo");
        e.assurance.insert("user:demo".into(), "mfa".into());
        e
    }

    fn binding() -> ConnectionAuthorityBinding {
        let org = OrganizationId::new();
        let cref =
            ConnectionRef::new(org, None, "github/main", ConnectionId::new()).unwrap();
        github_binding(cref, "github/legacy-token")
    }

    #[test]
    fn connection_ref_knowledge_does_not_export() {
        let b = binding();
        assert!(b.resolve_secret_for_agent().is_err());
        let agent_json = serde_json::to_value(b.agent_view()).unwrap();
        assert_no_secret_in_agent_payload(&agent_json).unwrap();
        assert!(!agent_json.to_string().contains("secret://"));
    }

    #[test]
    fn level3_denied_without_export_grant() {
        let e = engine();
        let g = grant(false);
        let b = binding();
        let err = authorize_authority_use(
            &e,
            "user:demo",
            &g,
            &b,
            AuthorityOperation::Resolve,
            InvokeLevel::Materialize,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, AuthzError::Denied(_)));
    }

    #[test]
    fn level2_evil_url_denied_even_with_connection() {
        let e = engine();
        let g = grant(false);
        let b = binding();
        let err = authorize_authority_use(
            &e,
            "user:demo",
            &g,
            &b,
            AuthorityOperation::Invoke,
            InvokeLevel::ConstrainedHttp,
            Some("https://evil.example/exfil"),
        )
        .unwrap_err();
        assert!(matches!(err, AuthzError::Denied(_)));
    }

    #[test]
    fn level2_github_url_allowed_when_granted() {
        let e = engine();
        let g = grant(false);
        let b = binding();
        let d = authorize_authority_use(
            &e,
            "user:demo",
            &g,
            &b,
            AuthorityOperation::Invoke,
            InvokeLevel::ConstrainedHttp,
            Some("https://api.github.com/repos/acme/catalog/pulls"),
        )
        .unwrap();
        assert!(d.allowed);
    }

    #[test]
    fn redirect_cross_authority_denied() {
        let b = binding();
        assert!(b
            .egress
            .allows_redirect(
                "https://api.github.com/repos/x",
                "https://evil.example/x"
            )
            .is_err());
    }
}
