use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::app_state::AppState;
use crate::middleware::auth::{
    require_demo_bootstrap, require_operator, require_session_or_operator, resolve_caller, Caller,
};

pub async fn status(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let n = st.sessions.lock().unwrap().len();
    Json(json!({"active_sessions": n})).into_response()
}

pub async fn whoami(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let boot = match require_demo_bootstrap(&st) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let (subject, organization_id, organization_role) = match caller {
        Caller::Operator => ("user:demo".to_string(), boot.org, "operator"),
        Caller::Session {
            subject,
            organization_id,
            role,
        } => (
            subject,
            organization_id,
            match role {
                opensesame_domain::OrganizationRole::Owner => "owner",
                opensesame_domain::OrganizationRole::Admin => "admin",
                opensesame_domain::OrganizationRole::Member => "member",
            },
        ),
    };
    Json(json!({
        "principal_id": subject,
        "actor_id": boot.actor.to_string(),
        "client_id": "cli:opensesame",
        "issuer": st.issuer,
        "assurance": "mfa",
        "organization_id": organization_id.to_string(),
        "organization_role": organization_role,
        "context": format!("{}/{}/", organization_id, boot.project)
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct RevokeSessionsRequest {
    principal_id: String,
    organization_id: String,
}

fn revoke_matching_sessions(
    sessions: &mut HashMap<String, serde_json::Value>,
    principal_id: &str,
    organization_id: &str,
) -> usize {
    let before = sessions.len();
    sessions.retain(|_, meta| {
        meta.get("principal_id").and_then(|value| value.as_str()) != Some(principal_id)
            || meta.get("organization_id").and_then(|value| value.as_str()) != Some(organization_id)
    });
    before - sessions.len()
}

fn revoke_pending_authorizations(
    pending: &mut HashMap<String, crate::app_state::DevicePending>,
    principal_id: &str,
    organization_id: opensesame_domain::OrganizationId,
) -> usize {
    let mut revoked = 0;
    for authorization in pending.values_mut() {
        if authorization.approved.as_ref().is_some_and(|approved| {
            approved.principal == principal_id && approved.organization_id == organization_id
        }) {
            authorization.approved = None;
            revoked += 1;
        }
    }
    revoked
}

pub async fn revoke(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<RevokeSessionsRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let organization_id = match opensesame_domain::OrganizationId::parse(&req.organization_id) {
        Ok(id) => id,
        Err(_) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_organization_id"})),
            )
                .into_response();
        }
    };
    let canonical_organization_id = organization_id.to_string();
    // Device-token minting holds this fence from reading its approval through
    // publishing the session. Revocation therefore observes and clears either
    // the pending grant or the minted session, never a gap between them.
    let _lifecycle = st.session_lifecycle.lock().unwrap();
    let mut sessions = st.sessions.lock().unwrap();
    let revoked =
        revoke_matching_sessions(&mut sessions, &req.principal_id, &canonical_organization_id);
    drop(sessions);

    // An approved device code can mint a session after this request. Clear matching
    // approvals too so a membership mutation revokes both live and not-yet-minted sessions.
    revoke_pending_authorizations(
        &mut st.device_codes.lock().unwrap(),
        &req.principal_id,
        organization_id,
    );

    Json(json!({"revoked": revoked})).into_response()
}

#[cfg(test)]
mod tests {
    use super::{revoke_matching_sessions, revoke_pending_authorizations};
    use crate::app_state::{ApprovedDevice, DevicePending};
    use chrono::{Duration, Utc};
    use opensesame_domain::{OrganizationId, OrganizationRole};
    use serde_json::json;
    use std::{
        collections::HashMap,
        sync::{mpsc, Arc, Barrier, Mutex},
        thread,
    };

    #[test]
    fn revocation_is_scoped_to_principal_and_organization() {
        let mut sessions = HashMap::from([
            (
                "target".into(),
                json!({"principal_id":"prn_target", "organization_id":"org_target"}),
            ),
            (
                "other-principal".into(),
                json!({"principal_id":"prn_other", "organization_id":"org_target"}),
            ),
            (
                "other-org".into(),
                json!({"principal_id":"prn_target", "organization_id":"org_other"}),
            ),
        ]);
        assert_eq!(
            revoke_matching_sessions(&mut sessions, "prn_target", "org_target"),
            1
        );
        assert!(!sessions.contains_key("target"));
        assert!(sessions.contains_key("other-principal"));
        assert!(sessions.contains_key("other-org"));
    }

    #[test]
    fn revocation_clears_matching_approved_device_codes() {
        let organization_id = OrganizationId::new();
        let approved = |principal: &str, organization_id| DevicePending {
            user_code_hash: "digest".into(),
            expires_at: Utc::now() + Duration::minutes(5),
            approved: Some(ApprovedDevice {
                principal: principal.into(),
                organization_id,
                organization_role: OrganizationRole::Member,
            }),
        };
        let mut pending = HashMap::from([
            ("target".into(), approved("prn_target", organization_id)),
            ("other".into(), approved("prn_other", organization_id)),
        ]);
        assert_eq!(
            revoke_pending_authorizations(&mut pending, "prn_target", organization_id),
            1
        );
        assert!(pending["target"].approved.is_none());
        assert!(pending["other"].approved.is_some());
    }

    #[test]
    fn revocation_matches_the_canonical_organization_spelling() {
        let organization_id = OrganizationId::new();
        let mut sessions = HashMap::from([(
            "target".into(),
            json!({
                "principal_id": "prn_target",
                "organization_id": organization_id.to_string(),
            }),
        )]);

        let bare_request_id = organization_id.as_uuid().to_string();
        let normalized = OrganizationId::parse(&bare_request_id)
            .expect("bare UUID is accepted at the API boundary")
            .to_string();
        assert_eq!(
            revoke_matching_sessions(&mut sessions, "prn_target", &normalized),
            1
        );
        assert!(sessions.is_empty());
    }

    #[test]
    fn revocation_waiting_on_a_token_mint_clears_the_new_session() {
        let organization_id = OrganizationId::new();
        let lifecycle = Arc::new(Mutex::new(()));
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let pending = Arc::new(Mutex::new(HashMap::from([(
            "device".to_string(),
            DevicePending {
                user_code_hash: "digest".into(),
                expires_at: Utc::now() + Duration::minutes(5),
                approved: Some(ApprovedDevice {
                    principal: "prn_target".into(),
                    organization_id,
                    organization_role: OrganizationRole::Member,
                }),
            },
        )])));
        let mint_ready = Arc::new(Barrier::new(2));
        let release_mint = Arc::new(Barrier::new(2));

        let mint = {
            let lifecycle = Arc::clone(&lifecycle);
            let sessions = Arc::clone(&sessions);
            let pending = Arc::clone(&pending);
            let mint_ready = Arc::clone(&mint_ready);
            let release_mint = Arc::clone(&release_mint);
            thread::spawn(move || {
                let _fence = lifecycle.lock().unwrap();
                mint_ready.wait();
                release_mint.wait();
                pending.lock().unwrap().remove("device");
                sessions.lock().unwrap().insert(
                    "new-session".into(),
                    json!({
                        "principal_id": "prn_target",
                        "organization_id": organization_id.to_string(),
                    }),
                );
            })
        };
        mint_ready.wait();

        let (contending, contending_rx) = mpsc::channel();
        let revoke = {
            let lifecycle = Arc::clone(&lifecycle);
            let sessions = Arc::clone(&sessions);
            let pending = Arc::clone(&pending);
            thread::spawn(move || {
                contending.send(()).unwrap();
                let _fence = lifecycle.lock().unwrap();
                revoke_matching_sessions(
                    &mut sessions.lock().unwrap(),
                    "prn_target",
                    &organization_id.to_string(),
                );
                revoke_pending_authorizations(
                    &mut pending.lock().unwrap(),
                    "prn_target",
                    organization_id,
                );
            })
        };
        contending_rx.recv().unwrap();
        assert!(
            lifecycle.try_lock().is_err(),
            "mint holds the lifecycle fence"
        );
        release_mint.wait();
        mint.join().unwrap();
        revoke.join().unwrap();

        assert!(sessions.lock().unwrap().is_empty());
        assert!(pending.lock().unwrap().is_empty());
    }
}

pub async fn list_connections(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    let Some(connection_ref) = &st.connection_ref else {
        return Json(json!({"connections": []})).into_response();
    };
    // Agent surface: ConnectionRef only — never SecretRef / raw credential handles.
    Json(json!({
        "connections": [{
            "connection_ref": connection_ref.handle.uri(),
            "connection_id": connection_ref.connection_id.to_string(),
            "logical_name": connection_ref.handle.logical_name,
            "max_invoke_level": 2,
            "operations": ["repository.read", "pull_request.create"]
        }]
    }))
    .into_response()
}
