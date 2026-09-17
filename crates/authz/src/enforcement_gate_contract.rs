//! Contract tests for the enforcement fence on the grant path.
//!
//! These live beside the gate rather than inside it so the module itself stays
//! within the structural budget; they are the same contracts, unchanged.

use crate::{
    admit_authority_use, admit_grant, admit_issuance, authorize_authority_use_enforced,
    descriptor_for_invoke, surface_for, terms_of, AuthorityUse, AuthzError, EnforcementRefused,
    PolicyEngine,
};
use chrono::{Duration, Utc};
use opensesame_domain::{
    AuthorityOperation, ConnectionId, ConnectionRef, Grant, GrantConstraints, GrantId, InvokeLevel,
    OfflineUse, OrganizationId, PrincipalId,
};
use opensesame_enforcement::{
    AdapterStatus, Bypass, Dimension, EnforcementDescriptor, EnforcementPoint, Guarantee, Latency,
    Mechanism, Observability, Remedy, Shortfall, SubjectSurface, Survival, Unsupported,
    UnsupportedReason,
};

const MODULE: AdapterStatus = AdapterStatus::Implemented {
    module: "crates/authz/src/enforcement_gate.rs",
};

fn grant(export: bool, offline_use: OfflineUse) -> Grant {
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
        actions: vec!["repository.read".into()],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(1),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 0,
            offline_use,
            raw_credential_export: export,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    }
}

/// A provider that lapses its own tokens and offers nothing else: a TTL on
/// expiry, no revocation endpoint, and no boundary once the value is out.
fn token_ttl_only() -> EnforcementDescriptor {
    EnforcementDescriptor::builder(
        "ttl-only-provider",
        SubjectSurface::MintedCredential,
        MODULE,
    )
    .enforced(
        Dimension::Expiry,
        Guarantee::new(
            Mechanism::ProviderTokenTtl,
            EnforcementPoint::Provider,
            Bypass::DistinctAuthority,
            Latency::WithinSeconds(3600),
            Survival::NetworkPartition,
            Observability::Inferred,
        ),
    )
    .unsupported(
        Dimension::Termination,
        Unsupported::new(
            UnsupportedReason::ProviderDoesNotOffer,
            Remedy::ChooseProviderWithControl,
            "the provider exposes no revocation endpoint",
        ),
    )
    .unsupported(
        Dimension::Isolation,
        Unsupported::new(
            UnsupportedReason::ValueLeftTheBoundary,
            Remedy::BrokerTheInvocation,
            "the value was minted into the subject's hands",
        ),
    )
    .build()
    .expect("an honest TTL-only provider")
}

/// A supervised host that holds all three: the grant's deadline on the call
/// path, a kill on the process group, and a sandbox around it.
fn supervised_host() -> EnforcementDescriptor {
    let held = |mechanism, point, survival| {
        Guarantee::new(
            mechanism,
            point,
            Bypass::DistinctAuthority,
            Latency::BeforeNextUse,
            survival,
            Observability::Reported,
        )
    };
    EnforcementDescriptor::builder("linux-host", SubjectSurface::BrokeredInvocation, MODULE)
        .enforced(
            Dimension::Expiry,
            held(
                Mechanism::GrantExpiryCheck,
                EnforcementPoint::HostBroker,
                Survival::NetworkPartition,
            ),
        )
        .enforced(
            Dimension::Termination,
            held(
                Mechanism::ProcessTermination,
                EnforcementPoint::OsKernel,
                Survival::NetworkPartition,
            ),
        )
        .enforced(
            Dimension::Isolation,
            held(
                Mechanism::OsSandbox,
                EnforcementPoint::OsKernel,
                Survival::ProcessLifetime,
            ),
        )
        .build()
        .expect("a supervised host holds all three")
}

#[test]
fn a_grant_demanding_termination_is_refused_by_a_token_ttl() {
    // Every grant is revocable, so termination is always demanded. A provider
    // TTL answers expiry and says nothing about stopping a run — the audit will
    // not even let it claim otherwise. The failure this guards is issuing the
    // grant anyway and discovering the gap when somebody tries to revoke.
    let refusal = match admit_grant(&grant(true, OfflineUse::Forbidden), &token_ttl_only())
        .expect_err("a TTL is not a termination story")
    {
        EnforcementRefused::CannotHold(refusal) => refusal,
        other => panic!("expected a shortfall, got {other:?}"),
    };
    assert_eq!(refusal.platform, "ttl-only-provider");
    assert!(refusal.cites_unsupported());
    let termination: Vec<_> = refusal
        .unmet
        .iter()
        .filter(|unmet| unmet.dimension == Dimension::Termination)
        .collect();
    assert_eq!(termination.len(), 1, "{:?}", refusal.unmet);
    let Shortfall::NotEnforced { response } = termination[0].shortfall else {
        panic!("nothing enforces it, so it is not a degree of shortfall");
    };
    assert_eq!(response.reason, UnsupportedReason::ProviderDoesNotOffer);
    assert_eq!(response.remedy, Remedy::ChooseProviderWithControl);
    // Expiry is held by the TTL, so it is not on the bill.
    assert!(refusal
        .unmet
        .iter()
        .all(|unmet| unmet.dimension != Dimension::Expiry));
}

#[test]
fn a_sealed_grant_on_a_ttl_provider_is_refused_on_isolation_too() {
    // Not degraded to "expiry only": the whole bill, so an operator makes one
    // decision instead of a sequence of them.
    let refusal = admit_grant(&grant(false, OfflineUse::Forbidden), &token_ttl_only())
        .expect_err("no boundary, no revocation");
    let EnforcementRefused::CannotHold(refusal) = refusal else {
        panic!("expected a shortfall");
    };
    let mut dimensions: Vec<_> = refusal.unmet.iter().map(|u| u.dimension).collect();
    dimensions.dedup();
    assert_eq!(
        dimensions,
        vec![Dimension::Termination, Dimension::Isolation]
    );
}

#[test]
fn a_supervised_host_admits_the_same_grant_and_names_what_holds_it() {
    let admitted = admit_grant(&grant(false, OfflineUse::Forbidden), &supervised_host())
        .expect("all three dimensions are held");
    assert_eq!(admitted.platform(), "linux-host");
    assert_eq!(
        admitted
            .guarantee(Dimension::Termination)
            .map(|g| g.mechanism),
        Some(Mechanism::ProcessTermination)
    );
    assert_eq!(admitted.held().len(), 3);
}

#[test]
fn a_pre_authorized_grant_raises_the_survival_floor_it_is_judged_against() {
    // Acting while disconnected raises the floor on expiry and termination to a
    // network partition, which the supervised host meets.
    let offline = grant(false, OfflineUse::PreAuthorized);
    admit_grant(&offline, &supervised_host()).expect("the host survives a partition");
    assert_eq!(
        terms_of(&offline).offline_use,
        opensesame_enforcement::OfflineUse::PreAuthorized
    );
}

#[test]
fn a_descriptor_for_another_surface_is_refused_rather_than_reinterpreted() {
    let engine = PolicyEngine::default();
    let held = grant(true, OfflineUse::Forbidden);
    let org = OrganizationId::new();
    let connection_ref =
        ConnectionRef::new(org, None, "github/main", ConnectionId::new()).expect("a ref");
    let binding = crate::github_binding(connection_ref, "github/legacy-token");
    let use_ = AuthorityUse {
        subject: "user:demo",
        grant: &held,
        binding: &binding,
        op: AuthorityOperation::Invoke,
        level: InvokeLevel::ConstrainedHttp,
        requested_url: Some("https://api.github.com/repos/acme/catalog/pulls"),
        requested_action: Some("repository.read"),
        connection_policy_id: "demo-conn",
        lineage: None,
    };
    // The use is brokered; the descriptor speaks for a minted credential.
    let refused = admit_authority_use(&use_, &token_ttl_only())
        .expect_err("a minted-credential descriptor does not judge a brokered call");
    assert!(matches!(
        refused,
        EnforcementRefused::SurfaceMismatch {
            running_on: SubjectSurface::BrokeredInvocation,
            ..
        }
    ));
    assert_eq!(
        surface_for(InvokeLevel::Materialize),
        SubjectSurface::MintedCredential
    );
    // And the wired path refuses as an enforcement gap, not a policy denial.
    let error = authorize_authority_use_enforced(&engine, &use_, &token_ttl_only())
        .expect_err("the gate runs before policy");
    assert!(matches!(error, AuthzError::EnforcementUnavailable(_)));
}

#[test]
fn offline_use_projects_every_domain_variant() {
    use opensesame_enforcement::OfflineUse as Enforced;
    for (domain, expected) in [
        (OfflineUse::Forbidden, Enforced::Forbidden),
        (OfflineUse::ReadOnly, Enforced::ReadOnly),
        (OfflineUse::PreAuthorized, Enforced::PreAuthorized),
    ] {
        assert_eq!(terms_of(&grant(false, domain)).offline_use, expected);
    }
}

#[test]
fn admit_issuance_admits_the_host_broker() {
    let terms = terms_of(&grant(false, OfflineUse::Forbidden));
    let admitted =
        admit_issuance("host-brokered-invocation", terms).expect("the broker holds sealed terms");
    assert_eq!(admitted.platform(), "host-brokered-invocation");
}

#[test]
fn admit_issuance_refuses_absent_adapters() {
    let terms = terms_of(&grant(false, OfflineUse::Forbidden));
    for platform in ["apple-ios", "android", "discord-live", "blocky-live-saas"] {
        let error = admit_issuance(platform, terms)
            .expect_err("an absent adapter cannot carry a sealed grant");
        match error {
            EnforcementRefused::CannotHold(refusal) => {
                assert_eq!(refusal.platform, platform);
                assert!(refusal.cites_unsupported(), "{platform}");
            }
            other => panic!("{platform} should be a shortfall, got {other:?}"),
        }
    }
}

#[test]
fn admit_issuance_refuses_an_unknown_platform() {
    let terms = terms_of(&grant(false, OfflineUse::Forbidden));
    let error = admit_issuance("not-a-platform", terms).expect_err("unknown");
    assert!(matches!(
        error,
        EnforcementRefused::UnknownPlatform(name) if name == "not-a-platform"
    ));
}

#[test]
fn invoke_descriptors_match_the_surface() {
    let brokered = descriptor_for_invoke(InvokeLevel::TypedOperation).expect("catalog");
    assert_eq!(brokered.platform(), "host-brokered-invocation");
    let http = descriptor_for_invoke(InvokeLevel::ConstrainedHttp).expect("catalog");
    assert_eq!(http.platform(), "host-brokered-invocation");
    let minted = descriptor_for_invoke(InvokeLevel::Materialize).expect("catalog");
    assert_eq!(minted.platform(), "host-minted-token");
}
