//! Contract tests pinning the route table in `mod.rs` against the committed
//! OpenAPI spec (`api/openapi/openapi.yaml`, OpenAPI 3.1, server `/api/v1`).
//! Both directions are checked statically — a route added to `mod.rs` fails
//! until it is either documented in the spec or consciously allowlisted
//! below, and a spec entry with no backing route fails too — plus a dynamic
//! probe that every documented (path, method) is registered with the router.

use std::collections::{BTreeMap, BTreeSet};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

use crate::app_state;
use crate::config::Args;

const SPEC: &str = include_str!("../../../../api/openapi/openapi.yaml");
const ROUTES: &str = include_str!("mod.rs");

/// Routes deliberately absent from the public OpenAPI spec, as
/// (route path, method). A route added to `mod.rs` fails
/// `implementation_routes_are_documented_or_allowlisted` until it is either
/// documented in the spec or listed here under its category.
const UNDOCUMENTED_ROUTES: &[(&str, &str)] = &[
    // Orchestrator liveness/readiness probes — operational surface, not API.
    ("/health/live", "GET"),
    ("/health/ready", "GET"),
    ("/health/authority", "GET"),
    ("/health/degraded", "GET"),
    ("/health/providers", "GET"),
    ("/api/v1/health", "GET"),
    // Public discovery metadata (protected-resource metadata, agent card, auth doc).
    ("/.well-known/oauth-protected-resource", "GET"),
    ("/.well-known/agent-card.json", "GET"),
    ("/auth.md", "GET"),
    // Loopback-only local session mint for the device CLI, not the remote contract.
    ("/api/v1/session/local", "POST"),
    // NATS authorization callout — server-to-server, not session callers.
    ("/api/v1/nats/auth/callout", "POST"),
    // Host operator task-bus configuration surface.
    ("/api/v1/operator/taskbus", "GET"),
    ("/api/v1/operator/taskbus", "PUT"),
    ("/api/v1/operator/taskbus/ping", "POST"),
    // Infisical-style private CA / dev-certificate issuance (session or operator).
    ("/api/v1/certs", "GET"),
    ("/api/v1/certs/ca", "GET"),
    ("/api/v1/certs/issue", "POST"),
    // GitHub App manifest registration flow, its callback, and the provider webhook.
    ("/api/v1/providers/github/app", "POST"),
    ("/api/v1/oauth/github-app/callback", "GET"),
    ("/api/v1/webhooks/github", "GET"),
    ("/api/v1/webhooks/github", "POST"),
    // ADR 0039 server-side backup target configuration and resync.
    ("/api/v1/backup/target", "GET"),
    ("/api/v1/backup/target", "PUT"),
    ("/api/v1/backup/target", "DELETE"),
    ("/api/v1/backup/resync", "POST"),
    // GitHub App installation listing behind the backup/integration UX.
    ("/api/v1/integrations/{id}/github/installations", "GET"),
    // GitHub repo provisioning behind a connection.
    ("/api/v1/connections/{id}/github/repos", "GET"),
    ("/api/v1/connections/{id}/github/repos", "POST"),
    // Agent claim ceremony polling/completion (agent- and operator-facing).
    ("/api/v1/agent-claims/{id}/poll", "POST"),
    ("/api/v1/agent-claims/{id}/complete", "POST"),
    // Operator break-glass authority registration.
    ("/api/v1/admin/authority", "POST"),
    // E2EE client sync — opaque ciphertext; the contract lives in client-core.
    ("/api/v1/sync/push", "POST"),
    ("/api/v1/sync/pull", "POST"),
    ("/api/v1/sync/blobs/snapshot", "POST"),
    ("/api/v1/sync/blobs/push", "POST"),
    // WP-D: project changelog metadata.
    ("/api/v1/projects/{project_id}/changelog", "GET"),
    ("/api/v1/changelog", "POST"),
    // WP-C: sync targets — ConnectionRef fan-out.
    ("/api/v1/sync-targets", "GET"),
    ("/api/v1/sync-targets", "POST"),
    ("/api/v1/sync-targets/sync-all", "POST"),
    ("/api/v1/sync-targets/{id}", "GET"),
    ("/api/v1/sync-targets/{id}", "DELETE"),
    ("/api/v1/sync-targets/{id}/sync", "POST"),
    // WP-E: credential rotation requests.
    ("/api/v1/rotations", "GET"),
    ("/api/v1/rotations", "POST"),
    ("/api/v1/rotations/{id}", "GET"),
    // Experimental AAUTH protocol surface — deliberately unpublished.
    ("/experimental/aauth/v1/status", "GET"),
    ("/experimental/aauth/v1/map/person", "POST"),
    ("/experimental/aauth/v1/map/agent", "POST"),
    ("/experimental/aauth/v1/mission/digest", "POST"),
];

type RouteMap = BTreeMap<String, BTreeSet<String>>;

const METHODS: [&str; 5] = ["get", "post", "put", "delete", "patch"];

/// (path, method) pairs documented by the spec, with the `/api/v1` server
/// prefix applied so they compare directly against route-table paths. The
/// YAML is parsed line-wise on its stable indentation: path keys are
/// two-space-indented `/...:` lines under `paths:`, operations are
/// four-space-indented `get:`/`post:`/… lines beneath them.
fn documented_routes() -> RouteMap {
    let mut routes = RouteMap::new();
    let mut in_paths = false;
    let mut current: Option<String> = None;
    for line in SPEC.lines() {
        if !line.is_empty() && !line.starts_with(' ') {
            in_paths = line == "paths:";
            current = None;
            continue;
        }
        if !in_paths {
            continue;
        }
        if line.starts_with("  /") && line.ends_with(':') {
            current = Some(line.trim_end_matches(':').trim().to_string());
        } else if let Some(path) = &current {
            for method in METHODS {
                if line == ["    ", method, ":"].concat() {
                    routes
                        .entry(format!("/api/v1{path}"))
                        .or_default()
                        .insert(method.to_uppercase());
                }
            }
        }
    }
    routes
}

/// (path, method) pairs registered in `mod.rs`, parsed from the `.route(...)`
/// calls so the table is pinned without a new dependency. Each call is
/// scanned from its opening paren to the matching close at depth zero; the
/// HTTP method helpers (`get(`, `.put(`, …) inside that span are the routed
/// methods.
fn implemented_routes() -> RouteMap {
    let mut routes = RouteMap::new();
    let mut offset = 0;
    while let Some(found) = ROUTES[offset..].find(".route(") {
        let open = offset + found + ".route".len(); // index of the call's '('
        let mut depth = 0usize;
        let mut close = ROUTES.len();
        for (i, ch) in ROUTES[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let args = &ROUTES[open + 1..close];
        let path = args
            .trim_start()
            .strip_prefix('"')
            .and_then(|rest| rest.split('"').next())
            .expect("route path literal")
            .to_string();
        let mut methods = BTreeSet::new();
        for method in METHODS {
            let token = [method, "("].concat();
            let mut search = 0;
            while let Some(pos) = args[search..].find(&token) {
                let at = search + pos;
                // A routing helper is preceded by `(`, `.`, or whitespace —
                // never by an identifier character or `::` (which would be a
                // handler path such as `connections::get(`).
                let helper = at == 0
                    || !matches!(
                        args.as_bytes()[at - 1],
                        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b':'
                    );
                if helper {
                    methods.insert(method.to_uppercase());
                }
                search = at + token.len();
            }
        }
        assert!(
            !methods.is_empty(),
            "no HTTP method helper parsed for route {path}"
        );
        routes.entry(path).or_default().extend(methods);
        offset = close;
    }
    routes
}

#[test]
fn implementation_routes_are_documented_or_allowlisted() {
    let documented = documented_routes();
    let allowlist: BTreeSet<(&str, &str)> = UNDOCUMENTED_ROUTES.iter().copied().collect();
    let mut undocumented = Vec::new();
    for (path, methods) in implemented_routes() {
        for method in methods {
            let in_spec = documented.get(&path).is_some_and(|m| m.contains(&method));
            if !in_spec && !allowlist.contains(&(path.as_str(), method.as_str())) {
                undocumented.push(format!("{method} {path}"));
            }
        }
    }
    assert!(
        undocumented.is_empty(),
        "routes missing from api/openapi/openapi.yaml and UNDOCUMENTED_ROUTES:\n{}",
        undocumented.join("\n")
    );
}

#[test]
fn allowlist_has_no_stale_entries() {
    let implemented = implemented_routes();
    let stale: Vec<String> = UNDOCUMENTED_ROUTES
        .iter()
        .filter(|(path, method)| {
            !implemented
                .get(*path)
                .is_some_and(|methods| methods.contains(*method))
        })
        .map(|(path, method)| format!("{method} {path}"))
        .collect();
    assert!(
        stale.is_empty(),
        "UNDOCUMENTED_ROUTES entries with no matching route in mod.rs:\n{}",
        stale.join("\n")
    );
}

#[test]
fn documented_routes_are_implemented() {
    let implemented = implemented_routes();
    let mut missing = Vec::new();
    for (path, methods) in documented_routes() {
        for method in methods {
            if !implemented.get(&path).is_some_and(|m| m.contains(&method)) {
                missing.push(format!("{method} {path}"));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "spec entries with no route in apps/gateway/src/routes/mod.rs:\n{}",
        missing.join("\n")
    );
}

/// Every documented (path, method) must be registered with the router: any
/// status other than 404/405 (auth failure, validation error, even a broker
/// error) proves the route exists. Only the documented methods are probed —
/// a bare path match would answer the others with 405.
#[tokio::test]
async fn documented_routes_respond_on_the_router() {
    let _guard = app_state::test_env::lock();
    // Force the in-memory bus so an ambient NATS_URL cannot open sockets.
    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    let state = app_state::build(Args {
        listen: "127.0.0.1:0".parse().expect("listen"),
        resource: "https://opensesame.test".into(),
        issuer: "https://identity.test".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .expect("app state");
    for (path, methods) in documented_routes() {
        // Substitute a dummy value for every `{param}` segment.
        let mut uri = String::new();
        let mut rest = path.as_str();
        while let Some(start) = rest.find('{') {
            let end = rest[start..].find('}').expect("path param close") + start;
            uri.push_str(&rest[..start]);
            uri.push_str("contract-probe");
            rest = &rest[end + 1..];
        }
        uri.push_str(rest);
        for method in methods {
            let request = Request::builder()
                .method(method.as_str())
                .uri(&uri)
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .expect("request");
            let status = super::router(state.clone())
                .oneshot(request)
                .await
                .expect("router")
                .status();
            assert_ne!(
                status,
                StatusCode::NOT_FOUND,
                "{method} {uri} is documented but not routed"
            );
            assert_ne!(
                status,
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {uri} is documented but routed for other methods only"
            );
        }
    }
}
