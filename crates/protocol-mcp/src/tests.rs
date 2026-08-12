use super::*;
use opensesame_domain::{
    CapabilitySet, OrganizationId, ProtectedResource, ProtectedResourceId, ProtocolProfile,
    ProtocolProfileId, TokenPresentation, PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER,
    PROFILE_OPENSESAME_TASK_DPOP_RFC9449_V1,
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
fn a_path_scoped_audience_confines_the_request() {
    // One host, one MCP server per tenant — the ordinary shape. Origin alone
    // would let tenant-a's token pass the resource check for tenant-b.
    let resource = sample_resource("https://mcp.example.com/tenant-a");
    assert!(
        validate_resource_uri("https://mcp.example.com/tenant-a/tools/list", &resource).is_ok()
    );
    assert!(validate_resource_uri("https://mcp.example.com/tenant-a", &resource).is_ok());
    assert!(
        validate_resource_uri("https://mcp.example.com/tenant-b/tools/list", &resource).is_err()
    );
    // No crossing a segment boundary to get there.
    assert!(validate_resource_uri("https://mcp.example.com/tenant-attacker", &resource).is_err());
}

#[test]
fn a_request_uri_carrying_userinfo_is_refused() {
    let resource = sample_resource("https://mcp.example.com");
    assert!(validate_resource_uri("https://mcp.example.com@evil.test/tools", &resource).is_err());
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
