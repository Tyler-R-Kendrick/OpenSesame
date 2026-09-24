//! Every agent request checks the durable grant. Session cache is not authorization.
use crate::{
    app_state::AppState,
    routes::agent_capabilities::{claims, refused, CAPABILITIES},
};
use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use chrono::Utc;
use opensesame_claims::hash_secret;

/// The one spelling an agent capability is presented in. `require_session`
/// accepts agent claims only under this exact prefix, so every agent request
/// that reaches a handler has passed [`guard`].
pub const AGENT_BEARER: &str = "Bearer agent-capability:";

/// True when any scheme carries an `agent-capability:` credential.
pub fn names_agent_capability(authorization: &str) -> bool {
    authorization
        .trim_start()
        .split_once(char::is_whitespace)
        .map(|(_, credential)| credential.trim_start())
        .and_then(|credential| credential.get(..17))
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("agent-capability:"))
}

pub fn capability(method: &str, path: &str) -> Option<&'static str> {
    match (method, path) {
        ("GET", "/api/v1/whoami" | "/api/v1/session") => Some("agent:self"),
        ("GET", "/api/v1/tasks") => Some("host.tasks.read"),
        ("POST", "/api/v1/tasks") => Some("host.tasks.create"),
        ("POST", "/api/v1/tasks/intents" | "/api/v1/tasks/invoke") => Some("host.tasks.invoke"),
        ("POST", "/api/v1/sync/pull" | "/api/v1/sync/pull-page") => Some("host.sync.read"),
        ("POST", "/api/v1/sync/push") => Some("host.sync.write"),
        ("GET", path) => path
            .strip_prefix("/api/v1/tasks/")
            .filter(|id| opensesame_domain::TaskRunId::parse(id).is_ok())
            .map(|_| "host.tasks.read"),
        ("POST", path) => path
            .strip_prefix("/api/v1/tasks/")
            .and_then(|path| path.strip_suffix("/terminate"))
            .filter(|id| opensesame_domain::TaskRunId::parse(id).is_ok())
            .map(|_| "host.tasks.terminate"),
        _ => None,
    }
}

pub async fn guard(State(st): State<AppState>, request: Request, next: Next) -> Response {
    let authorization = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let Some(raw) = authorization.strip_prefix(AGENT_BEARER) else {
        // A non-canonical spelling of an agent credential (`bearer`, `BEARER`,
        // `DPoP`, padded) must never fall through to a session authenticator
        // that skips the durable grant and the capability ceiling.
        if names_agent_capability(authorization) {
            return refused();
        }
        return next.run(request).await;
    };
    if request.headers().contains_key("origin")
        || request.headers().contains_key("x-opensesame-operator")
        || raw.len() != 64
        || !raw.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return refused();
    }
    let digest = hash_secret(raw);
    let client = request
        .headers()
        .get("x-opensesame-agent-client")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let audience = request
        .headers()
        .get("x-opensesame-agent-audience")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let Some(required) = capability(request.method().as_str(), request.uri().path()) else {
        return refused();
    };
    let Ok(Some(grant)) = st.db.agent_grant(&digest, Utc::now().timestamp()).await else {
        return refused();
    };
    if grant.client_id != client || grant.audience != audience || grant.resource != st.resource {
        return refused();
    }
    let Some(claims) = claims(&grant) else {
        return refused();
    };
    if claims
        .capability_ceiling
        .iter()
        .any(|cap| !CAPABILITIES.contains(&cap.as_str()))
        || (required != "agent:self"
            && !claims.capability_ceiling.iter().any(|cap| cap == required))
    {
        return refused();
    }
    {
        let Ok(mut sessions) = st.sessions.lock() else {
            return refused();
        };
        sessions.retain(|_, claims| claims.expires_at > Utc::now());
        if sessions.len() >= 4096 && !sessions.contains_key(&digest) {
            return refused();
        }
        sessions.insert(digest, claims);
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agent_ceiling_cannot_reach_human_authority_or_encoded_aliases() {
        for path in [
            "/api/v1/agent/runs/control",
            "/api/v1/certs/1/key",
            "/api/v1/device/approve",
            "/api/v1/session/local",
            "/api/v1/operator/taskbus",
            "/api/v1/tasks/../device/approve",
            "/api/v1/tasks/%2e%2e",
            "/api/v1/agent-launches",
        ] {
            assert!(capability("POST", path).is_none());
        }
        assert_eq!(
            capability("POST", "/api/v1/tasks/invoke"),
            Some("host.tasks.invoke")
        );
        assert!(capability("DELETE", "/api/v1/tasks").is_none());
    }

    #[test]
    fn every_spelling_of_an_agent_credential_is_recognized() {
        for header in [
            "Bearer agent-capability:ab",
            "bearer agent-capability:ab",
            "BEARER AGENT-CAPABILITY:ab",
            "DPoP agent-capability:ab",
            "Bearer  agent-capability:ab",
            "  bearer\tagent-capability:ab",
        ] {
            assert!(names_agent_capability(header), "{header}");
        }
        for header in [
            "Bearer opaque-session:ab",
            "",
            "agent-capability:ab",
            "Bearer",
        ] {
            assert!(!names_agent_capability(header), "{header}");
        }
    }
}
