use opensesame_domain::{Capability, CapabilitySet, ResourceSelector};

/// Stub: map OAuth-style scope strings to internal capabilities.
///
/// Each scope becomes `action = scope`, `resource = Exact("*")`. Real MCP scope
/// grammar mapping is deferred until the draft stabilizes.
pub fn scopes_to_capability_set(scopes: &[impl AsRef<str>]) -> CapabilitySet {
    let capabilities = scopes
        .iter()
        .map(|scope| {
            Capability::new(
                scope.as_ref().to_string(),
                ResourceSelector::exact("*"),
            )
        })
        .collect();
    CapabilitySet::new(capabilities).canonicalize()
}
