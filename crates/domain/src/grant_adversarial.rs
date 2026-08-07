#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::{Duration, Utc};

    fn parent() -> Grant {
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
            project_id: Some(ProjectId::new()),
            environment_id: None,
            connection_id: Some(ConnectionId::new()),
            actions: vec!["a".into(), "b".into(), "c".into()],
            resources: vec!["r1".into(), "r2".into()],
            constraints: GrantConstraints {
                audiences: vec!["https://api.example".into(), "https://other".into()],
                not_before: None,
                expires_at: now + Duration::hours(2),
                required_assurance: Some("mfa".into()),
                authentication_max_age_seconds: Some(600),
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: [("calls".into(), 100), ("bytes".into(), 1000)]
                    .into_iter()
                    .collect(),
                maximum_delegation_depth: 2,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: false,
            },
            parent_grant_id: None,
            delegation_depth: 0,
            created_at: now,
            revoked_at: None,
        }
    }

    fn child_ok(p: &Grant) -> Grant {
        let mut c = p.clone();
        c.id = GrantId::new();
        c.parent_grant_id = Some(p.id);
        c.delegation_depth = 1;
        c.actions = vec!["a".into()];
        c.resources = vec!["r1".into()];
        c.constraints.audiences = vec!["https://api.example".into()];
        c.constraints.expires_at = p.constraints.expires_at - Duration::minutes(1);
        c.constraints.budgets.insert("calls".into(), 10);
        c.constraints.maximum_delegation_depth = 1;
        c
    }

    #[test]
    fn cannot_expand_audience() {
        let p = parent();
        let mut c = child_ok(&p);
        c.constraints.audiences.push("https://evil".into());
        assert!(Grant::validate_attenuation(&p, &c).is_err());
    }

    #[test]
    fn cannot_expand_budget() {
        let p = parent();
        let mut c = child_ok(&p);
        c.constraints.budgets.insert("calls".into(), 101);
        assert!(Grant::validate_attenuation(&p, &c).is_err());
    }

    #[test]
    fn cannot_add_new_budget_key() {
        let p = parent();
        let mut c = child_ok(&p);
        c.constraints.budgets.insert("new".into(), 1);
        assert!(Grant::validate_attenuation(&p, &c).is_err());
    }

    #[test]
    fn cannot_increase_max_delegation_depth() {
        let p = parent();
        let mut c = child_ok(&p);
        c.constraints.maximum_delegation_depth = 3;
        assert!(Grant::validate_attenuation(&p, &c).is_err());
    }

    #[test]
    fn depth_exceeds_parent_max() {
        let mut p = parent();
        p.constraints.maximum_delegation_depth = 0;
        let mut c = child_ok(&p);
        c.delegation_depth = 1;
        c.constraints.maximum_delegation_depth = 0;
        assert_eq!(
            Grant::validate_attenuation(&p, &c),
            Err(DomainError::DelegationDepthExceeded)
        );
    }

    #[test]
    fn org_mismatch() {
        let p = parent();
        let mut c = child_ok(&p);
        c.organization_id = OrganizationId::new();
        assert_eq!(
            Grant::validate_attenuation(&p, &c),
            Err(DomainError::OrganizationMismatch)
        );
    }

    #[test]
    fn cannot_enable_export() {
        let p = parent();
        let mut c = child_ok(&p);
        c.constraints.raw_credential_export = true;
        assert!(Grant::validate_attenuation(&p, &c).is_err());
    }

    #[test]
    fn cannot_extend_lifetime() {
        let p = parent();
        let mut c = child_ok(&p);
        c.constraints.expires_at = p.constraints.expires_at + Duration::hours(1);
        assert!(Grant::validate_attenuation(&p, &c).is_err());
    }

    #[test]
    fn revoked_not_active() {
        let mut g = parent();
        g.revoked_at = Some(Utc::now());
        assert_eq!(g.assert_active(Utc::now()), Err(DomainError::GrantRevoked));
    }

    #[test]
    fn not_before_future() {
        let mut g = parent();
        g.constraints.not_before = Some(Utc::now() + Duration::hours(1));
        assert_eq!(
            g.assert_active(Utc::now()),
            Err(DomainError::GrantTimeWindow)
        );
    }

    #[test]
    fn multi_level_attenuation_chain() {
        let mut p = parent();
        p.constraints.maximum_delegation_depth = 2;
        let mut c1 = child_ok(&p);
        c1.constraints.maximum_delegation_depth = 2;
        assert!(Grant::validate_attenuation(&p, &c1).is_ok());
        let mut c2 = c1.clone();
        c2.id = GrantId::new();
        c2.parent_grant_id = Some(c1.id);
        c2.delegation_depth = 2;
        c2.actions = vec!["a".into()];
        c2.constraints.maximum_delegation_depth = 0;
        c2.constraints.budgets.insert("calls".into(), 1);
        c2.constraints.expires_at = c1.constraints.expires_at - Duration::seconds(1);
        assert!(Grant::validate_attenuation(&c1, &c2).is_ok());
    }
}
