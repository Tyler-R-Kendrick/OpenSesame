//! A stand-in Host for the `rotate recipe` and `rotate signer` CLI tests, and
//! the way to run the real binary against it.

#![allow(dead_code)]

use std::path::Path;
use std::sync::{Arc, Mutex};

pub use crate::hooks_mock::{opensesame, serve, Request};
use serde_json::json;

pub const OPERATOR_TOKEN: &str = "0123456789abcdef0123456789abcdef-operator";
pub const EXAMPLE: &str =
    include_str!("../../../../docs/operators/examples/web-login-recipe.example.json");
pub const ENCODED_ORIGIN: &str = "https%3A%2F%2Flogin.example";

pub fn host() -> (String, Arc<Mutex<Vec<Request>>>) {
    serve(|request, _| {
        let operator = request.authorization.starts_with("Bearer operator:");
        let recipes = "/api/v1/web-login/recipes";
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/api/v1/web-login/signers") if !operator => (
                "403 Forbidden",
                json!({
                    "error": "step_up_required",
                    "reason": "no_step_up",
                    "hint": "to pin a web-login recipe signer this session needs a step-up",
                }),
            ),
            ("POST", "/api/v1/web-login/signers") => (
                "201 Created",
                json!({"signer": {"key_id": "rsk_pinned", "algorithm": "ed25519"}}),
            ),
            ("GET", "/api/v1/web-login/signers") => (
                "200 OK",
                json!({"signers": [{
                    "key_id": "rsk_0123456789abcdef0123456789abcdef",
                    "label": "release-signer",
                    "pinned_at": "2026-10-01T00:00:00+00:00",
                    "revoked_at": null,
                }]}),
            ),
            ("DELETE", path) if path.starts_with("/api/v1/web-login/signers/") => (
                "200 OK",
                json!({"signer": {"revoked_at": "2026-10-02T00:00:00+00:00"}}),
            ),
            ("GET", path) if path == recipes => (
                "200 OK",
                json!({"recipes": [{
                    "origin": "https://login.example",
                    "trust": "canary_verified",
                    "version": 2,
                    "signer_key_id": "rsk_0123456789abcdef0123456789abcdef",
                    "canary": {"result": "passed", "source": "run"},
                    "runnable": {"attended": true, "unattended": true},
                }]}),
            ),
            ("POST", path) if path.ends_with("/canary") => (
                "202 Accepted",
                json!({"status": "started", "origin": "https://login.example"}),
            ),
            ("PUT", _) => (
                "201 Created",
                json!({"recipe": {"trust": "candidate", "version": 1}}),
            ),
            ("DELETE", _) => (
                "200 OK",
                json!({"deleted": true, "origin": "https://login.example"}),
            ),
            ("GET", _) => (
                "200 OK",
                json!({"recipe": {"trust": "candidate"}, "document": {"origin": "https://login.example"}}),
            ),
            _ => ("404 Not Found", json!({"error": "not_found"})),
        }
    })
}

pub fn rotate(config: &Path, server: &str) -> std::process::Command {
    let mut command = opensesame(config);
    command
        .env("OPENSESAME_OPERATOR_TOKEN", OPERATOR_TOKEN)
        .args(["--server", server, "access", "connectors", "rotate"]);
    command
}
