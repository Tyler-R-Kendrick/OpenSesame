//! Additional route ceiling for an Identity-authenticated, paired browser.
//!
//! This map does not authorize a resource: handlers still enforce current
//! organization, ownership and role/project policy. It is never added to a
//! local-read grant. Native administration, materialization and browser control
//! deliberately have no entry here.

pub const CAPABILITIES: &[&str] = &[
    "host.connections.read",
    "host.connections.write",
    "host.integrations.read",
    "host.integrations.write",
    "config.metadata.read",
    "config.keys.read",
    "config.write",
    "host.sync_targets.read",
    "host.sync_targets.write",
    "host.receipts.read",
    "host.rotations.read",
    "host.rotations.write",
    "host.ceremonies.read",
];

// Entire route shapes, not prefix grants. {id} is an opaque canonical segment;
// {key} additionally admits the dot used in configuration key names. Percent
// encoding is refused before matching so decoding cannot introduce aliases.
const ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "providers", "host.integrations.read"),
    ("GET", "integrations", "host.integrations.read"),
    ("GET", "integrations/{id}", "host.integrations.read"),
    ("POST", "integrations", "host.integrations.write"),
    ("PATCH", "integrations/{id}", "host.integrations.write"),
    ("DELETE", "integrations/{id}", "host.integrations.write"),
    ("GET", "connections", "host.connections.read"),
    ("GET", "connections/{id}", "host.connections.read"),
    ("GET", "connections/{id}/events", "host.connections.read"),
    (
        "GET",
        "connections/{id}/github/repos",
        "host.connections.read",
    ),
    ("POST", "connections", "host.connections.write"),
    ("PATCH", "connections/{id}", "host.connections.write"),
    ("DELETE", "connections/{id}", "host.connections.write"),
    (
        "POST",
        "connections/{id}/authorize",
        "host.connections.write",
    ),
    ("POST", "connections/{id}/refresh", "host.connections.write"),
    (
        "POST",
        "connections/{id}/credential",
        "host.connections.write",
    ),
    (
        "POST",
        "connections/{id}/bindings",
        "host.connections.write",
    ),
    (
        "DELETE",
        "connections/{id}/bindings/{id}",
        "host.connections.write",
    ),
    (
        "POST",
        "connections/{id}/github/repos",
        "host.connections.write",
    ),
    ("GET", "projects/{id}/configs", "config.metadata.read"),
    ("GET", "configs/{id}", "config.metadata.read"),
    ("GET", "configs/{id}/compare/{id}", "config.keys.read"),
    ("GET", "projects/{id}/changelog", "config.keys.read"),
    ("GET", "projects/{id}/config-access", "config.metadata.read"),
    ("PUT", "projects/{id}/config-access/{id}", "config.write"),
    ("GET", "configs/{id}/secrets", "config.keys.read"),
    (
        "GET",
        "configs/{id}/secrets/{key}/versions",
        "config.keys.read",
    ),
    ("POST", "projects/{id}/configs", "config.write"),
    ("DELETE", "configs/{id}", "config.write"),
    ("PUT", "configs/{id}/secrets", "config.write"),
    ("DELETE", "configs/{id}/secrets/{key}", "config.write"),
    (
        "POST",
        "configs/{id}/secrets/{key}/rollback",
        "config.write",
    ),
    ("POST", "configs/{id}/branch", "config.write"),
    ("GET", "sync-targets", "host.sync_targets.read"),
    ("GET", "sync-targets/{id}", "host.sync_targets.read"),
    ("POST", "sync-targets", "host.sync_targets.write"),
    ("DELETE", "sync-targets/{id}", "host.sync_targets.write"),
    ("POST", "sync-targets/{id}/sync", "host.sync_targets.write"),
    ("POST", "sync-targets/sync-all", "host.sync_targets.write"),
    ("GET", "receipts/keys", "host.receipts.read"),
    ("GET", "receipts/{id}", "host.receipts.read"),
    ("POST", "receipts/{id}/verify", "host.receipts.read"),
    ("GET", "rotations", "host.rotations.read"),
    ("GET", "rotations/{id}", "host.rotations.read"),
    ("GET", "rotation/policies", "host.rotations.read"),
    ("POST", "rotations", "host.rotations.write"),
    ("PUT", "rotation/policies", "host.rotations.write"),
    ("GET", "ceremonies", "host.ceremonies.read"),
];

fn segment(value: &str, key: bool) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || b"-_:".contains(&byte) || (key && byte == b'.')
        })
}

fn shape_matches(shape: &str, path: &str) -> bool {
    let mut actual = path.split('/');
    for expected in shape.split('/') {
        let Some(value) = actual.next() else {
            return false;
        };
        let matches = match expected {
            "{id}" => segment(value, false),
            "{key}" => segment(value, true),
            literal => value == literal,
        };
        if !matches {
            return false;
        }
    }
    actual.next().is_none()
}

pub fn required_capability(method: &str, path: &str) -> Option<&'static str> {
    // Axum exposes the path without query text. Never admit a caller passing a
    // URI, an encoded segment, a backslash, or a noncanonical route spelling.
    if path.len() > 1024 || path.bytes().any(|byte| b"%\\?#".contains(&byte)) {
        return None;
    }
    let tail = path.strip_prefix("/api/v1/")?;
    if tail == "connections/discover"
        || (tail == "sync-targets/sync-all" && method != "POST")
        || (tail == "receipts/keys" && method != "GET")
    {
        return None;
    }
    ROUTES.iter().find_map(|(verb, shape, capability)| {
        (*verb == method && shape_matches(shape, tail)).then_some(*capability)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_enumerated_route_has_a_declared_capability_and_exact_shape() {
        for (method, shape, capability) in ROUTES {
            assert!(CAPABILITIES.contains(capability));
            let path = format!(
                "/api/v1/{}",
                shape.replace("{id}", "id_123").replace("{key}", "app.KEY")
            );
            assert_eq!(
                required_capability(method, &path),
                Some(*capability),
                "{method} {path}"
            );
            for wrong_method in ["OPTIONS", "HEAD", "TRACE", "CONNECT", "get", "post"] {
                assert_eq!(required_capability(wrong_method, &path), None);
            }
            for alias in [
                format!("{path}/"),
                format!("{path}/unrecognized/extra/alias"),
                path.replace("/api/v1/", "/api//v1/"),
            ] {
                assert_eq!(required_capability(method, &alias), None, "{alias}");
            }
        }
    }

    #[test]
    fn privileged_secret_revealing_and_control_routes_are_not_browser_user_routes() {
        for path in [
            "/api/v1/session/local",
            "/api/v1/agent-launches",
            "/pair/decision",
            "/api/v1/device/approve",
            "/api/v1/claims/approve",
            "/api/v1/admin/users",
            "/api/v1/config-authorization/roles",
            "/api/v1/custom-providers",
            "/api/v1/providers/github/app",
            "/api/v1/credential-connections",
            "/api/v1/credential-providers/id/test",
            "/api/v1/connections/id/mint",
            "/api/v1/connections/discover",
            "/api/v1/certificates/issue",
            "/api/v1/certificates/id/key",
            "/api/v1/proxy",
            "/api/v1/invoke",
            "/api/v1/agent/runs/id/control",
            "/api/v1/agent/runs/id/steps/claim",
        ] {
            for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
                assert_eq!(required_capability(method, path), None, "{method} {path}");
            }
        }
    }

    #[test]
    fn encoded_ambiguous_and_noncanonical_identifiers_are_refused() {
        for id in [
            "%69d",
            "%2fadmin",
            "%252fadmin",
            "..",
            ".",
            "id/../other",
            "id\\other",
            "id?x=1",
            "id#fragment",
            "用户",
            "",
        ] {
            assert_eq!(
                required_capability("GET", &format!("/api/v1/connections/{id}")),
                None
            );
        }
        assert_eq!(
            required_capability("GET", &format!("/api/v1/connections/{}", "x".repeat(129))),
            None
        );
        assert_eq!(
            required_capability("GET", "/api/v1/configs/id/secrets/../versions"),
            None
        );
        assert_eq!(required_capability("POST", "/api/v1/receipts/id"), None);
        assert_eq!(required_capability("DELETE", "/api/v1/ceremonies"), None);
        assert_eq!(
            required_capability("GET", "/api/v1/configs/id/secrets/app.KEY/versions"),
            Some("config.keys.read")
        );
    }
}
