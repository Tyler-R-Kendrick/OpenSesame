use axum::{extract::State, http::header, response::IntoResponse, Json};
use serde_json::json;

use crate::app_state::AppState;

pub async fn metadata(State(st): State<AppState>) -> impl IntoResponse {
    // Honesty: do not advertise DPoP unless the validator/replay stack is enabled (ADR 0022/0023).
    let dpop = opensesame_proof::DpopAdvertisement::host_default();
    let mut meta = json!({
        "resource": st.resource,
        "authorization_servers": [st.issuer],
        "scopes_supported": ["opensesame.session", "opensesame.invoke"],
        "bearer_methods_supported": ["header"],
        "resource_signing_alg_values_supported": ["EdDSA", "RS256"],
        "opensesame_protocol_profiles": [
            "oauth-bearer-rfc6750-v1",
            "mcp-authorization-2026-07-28-bearer",
            "opensesame-task-dpop-rfc9449-v1"
        ],
        "opensesame_task_api": format!("{}/api/v1/tasks", st.resource),
    });
    if dpop.is_ready() {
        meta.as_object_mut().unwrap().insert(
            "dpop_signing_alg_values_supported".into(),
            json!(["EdDSA", "ES256"]),
        );
    }
    Json(meta)
}

pub async fn auth_md(State(st): State<AppState>) -> impl IntoResponse {
    let body = format!(
        r#"# OpenSesame Authorization

- Protected Resource Metadata: {resource}/.well-known/oauth-protected-resource
- Authorization Server: {issuer}/.well-known/openid-configuration
- Device Authorization: POST {resource}/api/v1/device/authorize
- Agent identity: POST {resource}/api/v1/agent-identities
- Claim poll: POST {resource}/api/v1/agent-claims/{{id}}/poll (body: claim_token)
- Invoke: POST {resource}/api/v1/intents with connection_ref (never SecretRef)
- Connections: GET {resource}/api/v1/connections
- Supported grants: authorization_code+PKCE (S256), urn:ietf:params:oauth:grant-type:device_code
- Pre-claim authority: none beyond draft metadata / poll
- Task API: POST {resource}/api/v1/tasks (immutable ceiling); POST {resource}/api/v1/tasks/intents (freeze)
- Proof: DPoP advertised only when OPENSESAME_DPOP_ENABLED=true; MCP Bearer is a separate profile
- Examples use placeholders only — never paste live credentials
- Agents exercise ConnectionRef + Intent; credential materialization is denied by default

"#,
        resource = st.resource,
        issuer = st.issuer
    );
    (
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        body,
    )
}

pub async fn agent_card(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "name": "OpenSesame",
        "description": "Private credential and authorization fabric",
        "url": st.resource,
        "version": "0.1.0",
        "capabilities": {"streaming": false},
        "defaultInputModes": ["application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": [{
            "id": "broker.invoke",
            "name": "Brokered connector invoke",
            "description": "Authorize -> invoke -> receipt without exposing raw credentials",
            "tags": ["authorization", "connectors"]
        }],
        "securitySchemes": {
            "oauth2": {
                "type": "oauth2",
                "authorization_servers": [st.issuer]
            }
        },
        "metadata": {
            "opensesame.claim": format!("{}/api/v1/agent-identities", st.resource),
            "opensesame.auth_md": format!("{}/auth.md", st.resource)
        }
    }))
}
