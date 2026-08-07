use super::*;
use opensesame_domain::{
    Capability, CapabilitySet, OrganizationId, ProtectedResource, ProtectedResourceId,
    ProtocolProfile, ProtocolProfileId, ResourceSelector, TokenPresentation,
    PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER, PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1,
};

#[test]
fn mcp_profile_is_bearer_only() {
    let profile = mcp_bearer_profile().unwrap();
    assert_eq!(profile.slug, PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER);
    assert_eq!(profile.minimum_presentation, TokenPresentation::Bearer);
    assert!(validate_presentation_for_profile(&profile, TokenPresentation::Bearer).is_ok());
}

#[test]
fn bearer_vs_dpop_confusion_rejected_for_mcp() {
    assert!(assert_mcp_bearer_presentation(TokenPresentation::DpopBound).is_err());
    assert!(assert_mcp_bearer_presentation(TokenPresentation::HttpMessageSignature).is_err());

    let mcp = mcp_bearer_profile().unwrap();
    assert!(validate_presentation_for_profile(&mcp, TokenPresentation::DpopBound).is_err());
}

#[test]
fn dpop_profile_rejects_bearer_confusion() {
    let task_dpop = ProtocolProfile::parse_slug(PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1).unwrap();
    assert!(task_dpop
        .assert_presentation_allowed(TokenPresentation::Bearer)
        .is_err());
    assert!(task_dpop
        .assert_presentation_allowed(TokenPresentation::DpopBound)
        .is_ok());
}

#[test]
fn token_passthrough_explicitly_rejected() {
    assert_eq!(
        reject_inbound_token_as_downstream_credential(),
        Err(McpError::TokenPassthroughForbidden)
    );
}

#[test]
fn audience_validation() {
    let resource = sample_resource("https://mcp.example.com");
    assert!(validate_audience("https://mcp.example.com", &resource).is_ok());
    assert!(validate_audience("https://other.example.com", &resource).is_err());
}

#[test]
fn resource_uri_same_origin() {
    let resource = sample_resource("https://mcp.example.com");
    assert!(validate_resource_uri("https://mcp.example.com/tools/list", &resource).is_ok());
    assert!(validate_resource_uri("https://evil.example.com/tools/list", &resource).is_err());
}

#[test]
fn scope_stub_maps_to_capabilities() {
    let set = scopes_to_capability_set(&["tools:read", "tools:call"]);
    assert_eq!(set.canonicalize().capabilities.len(), 2);
    assert!(set.is_subset_of(&CapabilitySet::new(vec![
        Capability::new("tools:read", ResourceSelector::exact("*")),
        Capability::new("tools:call", ResourceSelector::exact("*")),
        Capability::new("tools:write", ResourceSelector::exact("*")),
    ])));
}

fn sample_resource(audience: &str) -> ProtectedResource {
    ProtectedResource {
        id: ProtectedResourceId::new(),
        organization_id: OrganizationId::new(),
        project_id: None,
        name: "mcp-server".into(),
        audience: audience.into(),
        required_capabilities: CapabilitySet::new(vec![]),
        protocol_profile_id: ProtocolProfileId::from_slug(
            PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER,
        ),
        account_ref: None,
        external_mappings: vec![],
    }
}
