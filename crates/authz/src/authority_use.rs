//! Custodian-style authority exercise: `ConnectionRef` + Intent — never `SecretRef` to agents.

use crate::{
    AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject, AuthzError, PolicyEngine,
};
use opensesame_domain::{
    AuthorityHandle, AuthorityKind, AuthorityOperation, AvailabilityClass,
    ConnectionAuthorityBinding, ConnectionRef, DomainError, EgressBinding, Grant, InvokeLevel,
};
use serde_json::json;

#[derive(Clone, Debug)]
pub struct AuthorityDecision {
    pub allowed: bool,
    pub decision_id: String,
    pub policy_version_digest: String,
    pub reason: Option<String>,
}

/// One attempt to exercise authority over a connection.
#[derive(Clone, Debug)]
pub struct AuthorityUse<'a> {
    pub subject: &'a str,
    pub grant: &'a Grant,
    pub binding: &'a ConnectionAuthorityBinding,
    pub op: AuthorityOperation,
    pub level: InvokeLevel,
    pub requested_url: Option<&'a str>,
    /// The action this use claims to exercise. A grant lists actions; a use that
    /// names none cannot be checked against them.
    pub requested_action: Option<&'a str>,
    /// The id the relationship store keys this connection under. Owner
    /// eligibility is a tuple on this id; delegates pass on their grant's
    /// lineage instead (see `PolicyEngine::decide`).
    pub connection_policy_id: &'a str,
}

/// Enforce: reference ≠ capability; Level 3 export denied unless grant says so;
/// L2 HTTP must satisfy egress binding.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn authorize_authority_use(
    engine: &PolicyEngine,
    use_: &AuthorityUse<'_>,
) -> Result<AuthorityDecision, AuthzError> {
    let AuthorityUse {
        subject,
        grant,
        binding,
        op,
        level,
        requested_url,
        requested_action,
        connection_policy_id,
    } = *use_;
    if binding.connection_ref.handle.kind != AuthorityKind::Connection {
        return Err(AuthzError::Denied(
            "agent API accepts ConnectionRef only".into(),
        ));
    }

    if level > binding.max_invoke_level {
        return Err(AuthzError::Denied("invoke level not permitted".into()));
    }

    if (op.requires_export_privilege() || level == InvokeLevel::Materialize)
        && !grant.constraints.raw_credential_export
    {
        return Err(AuthzError::Denied(
            "credential materialization denied by default".into(),
        ));
    }

    if level == InvokeLevel::ConstrainedHttp {
        let url = requested_url.ok_or_else(|| {
            AuthzError::Denied("constrained HTTP requires URL bound to egress".into())
        })?;
        binding
            .egress
            .allows_url(url)
            .map_err(|e| AuthzError::Denied(e.to_string()))?;
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
            // The policy id the relationship store knows this connection by —
            // an earlier version hardcoded the demo id here, which made every
            // non-demo authority use check somebody else's tuple.
            "connection_id": connection_policy_id,
            // The durable connection id, for the delegated-capability check:
            // a child grant is eligibility only for the connection it names.
            "connection_uuid": binding.connection_ref.connection_id.to_string(),
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
    //
    // The action the engine checks is the one the caller asked for. It used to be
    // overwritten with `grant.actions.first()`, which made the engine's
    // "is this action granted?" check compare the grant against itself — a grant
    // listing `repository.read` authorized a `pull_request.create` all the same.
    let mut engine_req = req;
    if level != InvokeLevel::Materialize {
        let action = requested_action.ok_or_else(|| {
            AuthzError::Denied("authority use must name the action it exercises".into())
        })?;
        if !grant.actions.iter().any(|a| a == action) {
            return Err(AuthzError::Denied(format!("action not granted: {action}")));
        }
        engine_req.action.name = action.to_string();
        // The request stays connection-scoped. It used to be relabelled as a
        // `connector_operation` with a placeholder id, which would now slip past
        // the grant's resource scope on the strength of a resource nobody named;
        // on this path the target is the URL, fenced by the egress binding above.
    }

    match engine.decide(&engine_req, Some(grant), class) {
        Ok(d) if d.decision => Ok(AuthorityDecision {
            allowed: true,
            decision_id: d.decision_id,
            policy_version_digest: d.policy_version_digest,
            reason: None,
        }),
        Ok(d) => Ok(AuthorityDecision {
            allowed: false,
            decision_id: d.decision_id,
            policy_version_digest: d.policy_version_digest,
            reason: Some("policy denied".into()),
        }),
        Err(e) => Err(e),
    }
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
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

#[must_use]
pub fn github_binding(
    connection_ref: ConnectionRef,
    secret_logical: &str,
) -> ConnectionAuthorityBinding {
    let org = connection_ref.handle.organization_id;
    let project = connection_ref.handle.project_id;
    ConnectionAuthorityBinding {
        connection_ref,
        internal_secret: Some(AuthorityHandle::secret_internal(
            org,
            project,
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
                budgets: std::collections::BTreeMap::default(),
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
        let cref = ConnectionRef::new(org, None, "github/main", ConnectionId::new()).unwrap();
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
            &AuthorityUse {
                subject: "user:demo",
                grant: &g,
                binding: &b,
                op: AuthorityOperation::Resolve,
                level: InvokeLevel::Materialize,
                requested_url: None,
                requested_action: None,

                connection_policy_id: "demo-conn",
            },
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
            &AuthorityUse {
                subject: "user:demo",
                grant: &g,
                binding: &b,
                op: AuthorityOperation::Invoke,
                level: InvokeLevel::ConstrainedHttp,
                requested_url: Some("https://evil.example/exfil"),
                requested_action: Some("pull_request.create"),

                connection_policy_id: "demo-conn",
            },
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
            &AuthorityUse {
                subject: "user:demo",
                grant: &g,
                binding: &b,
                op: AuthorityOperation::Invoke,
                level: InvokeLevel::ConstrainedHttp,
                requested_url: Some("https://api.github.com/repos/acme/catalog/pulls"),
                requested_action: Some("pull_request.create"),

                connection_policy_id: "demo-conn",
            },
        )
        .unwrap();
        assert!(d.allowed);
    }

    #[test]
    fn an_action_the_grant_does_not_list_is_denied() {
        let e = engine();
        let g = grant(false);
        let b = binding();
        let url = Some("https://api.github.com/repos/acme/catalog/pulls");
        // The grant lists pull_request.create and repository.read, not this.
        let err = authorize_authority_use(
            &e,
            &AuthorityUse {
                subject: "user:demo",
                grant: &g,
                binding: &b,
                op: AuthorityOperation::Invoke,
                level: InvokeLevel::ConstrainedHttp,
                requested_url: url,
                requested_action: Some("repository.delete"),

                connection_policy_id: "demo-conn",
            },
        )
        .unwrap_err();
        assert!(matches!(err, AuthzError::Denied(m) if m.contains("repository.delete")));

        // A use that names no action cannot be checked against the grant's list.
        let err = authorize_authority_use(
            &e,
            &AuthorityUse {
                subject: "user:demo",
                grant: &g,
                binding: &b,
                op: AuthorityOperation::Invoke,
                level: InvokeLevel::ConstrainedHttp,
                requested_url: url,
                requested_action: None,

                connection_policy_id: "demo-conn",
            },
        )
        .unwrap_err();
        assert!(matches!(err, AuthzError::Denied(m) if m.contains("must name the action")));

        // Every action the grant does list is usable, not just the first.
        for action in ["pull_request.create", "repository.read"] {
            let d = authorize_authority_use(
                &e,
                &AuthorityUse {
                    subject: "user:demo",
                    grant: &g,
                    binding: &b,
                    op: AuthorityOperation::Invoke,
                    level: InvokeLevel::ConstrainedHttp,
                    requested_url: url,
                    requested_action: Some(action),

                    connection_policy_id: "demo-conn",
                },
            )
            .unwrap();
            assert!(d.allowed, "{action}");
        }
    }

    #[test]
    fn redirect_cross_authority_denied() {
        let b = binding();
        assert!(b
            .egress
            .allows_redirect("https://api.github.com/repos/x", "https://evil.example/x")
            .is_err());
    }
}
