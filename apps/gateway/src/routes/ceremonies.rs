//! What the ceremony catalog covers, and how far it gets (ADR 0082 §7).
//!
//! One route, and it returns the catalog **whole**. There is deliberately no
//! `GET /api/v1/ceremonies/{provider}`: asking a server which ceremony to use
//! for `provider-x` tells that server which provider this user is onboarding,
//! and the catalog is checked in precisely so nobody has to answer that
//! question (ADR 0052 §12 — a lookup is a disclosure). The caller takes the
//! whole list and matches locally, the same shape ADR 0080 §5 uses for the
//! public breach catalogue.
//!
//! Nothing here is tenant data. The catalog is compiled into the binary from
//! `crates/ceremony/catalog.json`, so this handler reads no database, scopes to
//! no organization, and returns the same bytes to every caller on the Host. It
//! still requires a caller: the Host API has no anonymous surface outside
//! `/health`, and adding one for this would be a new one.
//!
//! What goes over the wire is the capabilities *and* the tiers they resolve to.
//! The capabilities are the durable fact and the tier is a decision
//! ([`opensesame_ceremony::resolve`]), so shipping both means a client never has
//! to reimplement the ladder — and never gets to disagree with it about whether
//! a provider's own endpoint wins.

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_ceremony::{Catalog, CatalogEntry, Phase};
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;

/// One catalog entry as it goes over the wire.
///
/// `declares` is the slot names the ceremony may capture — not values, and not
/// a claim that any were captured. A slot is permission to seal one thing, and
/// this route is where a client learns what a ceremony is allowed to touch
/// before it agrees to run one.
///
/// Phase and tier names come from the crate's own frozen `as_str`, never from a
/// mapping written here: a second spelling of the ladder is a second thing to
/// keep in step with ADR 0082.
fn entry_view(entry: &CatalogEntry) -> serde_json::Value {
    json!({
        "provider_id": entry.provider_id,
        "native_registration": entry.native_registration,
        "native_registration_note": entry.native_registration_note,
        "recipe": entry.recipe,
        "agentic_allowed": entry.agentic_allowed,
        "declares": entry.declares,
        "verifies_by": entry.verifies_by,
        "note": entry.note,
        "runnable": entry.is_runnable(),
        "plan": entry
            .plan()
            .into_iter()
            .map(|(phase, tier)| json!({
                "phase": phase.as_str(),
                "tier": tier.as_str(),
                "uses_a_model": tier.uses_a_model(),
                "requires_a_present_user": tier.requires_a_present_user(),
            }))
            .collect::<Vec<_>>(),
        // Explicit non-disclosure, mirroring the run routes: a ceremony says
        // what may be captured, never what was.
        "secrets_returned": false,
    })
}

/// `GET /api/v1/ceremonies` — every provider the catalog covers.
///
/// A provider absent from this list is not an error and not a gap: every phase
/// resolves to C3 and it gets the copy-paste instructions it has today. ADR
/// 0082's alternatives section is explicit that a ceremony which cannot run
/// must leave the user where they started, so the honest way to say "no
/// ceremony" is to be absent rather than to be present and empty.
pub async fn list_ceremonies(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(resp) = resolve_caller(&st, &headers) {
        return resp;
    }
    let catalog = Catalog::load();
    let ceremonies: Vec<serde_json::Value> = catalog.entries().iter().map(entry_view).collect();
    Json(json!({
        "ceremonies": ceremonies,
        "phases": Phase::ALL.map(Phase::as_str),
        "secrets_returned": false,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{test_demo_state, test_session_headers};
    use axum::{body::Body, http::Request, http::StatusCode, Router};
    use opensesame_ceremony::Tier;
    use opensesame_domain::OrganizationRole;
    use serde_json::Value;
    use tower::ServiceExt;

    async fn get(app: &Router, headers: Option<&HeaderMap>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method("GET").uri("/api/v1/ceremonies");
        if let Some(headers) = headers {
            builder = builder.header(
                "authorization",
                headers.get("authorization").unwrap().as_bytes(),
            );
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn fixture() -> (Router, HeaderMap) {
        let state = test_demo_state().await;
        let org = state.connection_organization;
        let headers = test_session_headers(&state, "user:alice", org, OrganizationRole::Owner);
        (crate::routes::router(state.clone()), headers)
    }

    #[tokio::test]
    async fn the_catalog_reads_the_same_for_everybody_and_needs_a_caller() {
        let (app, alice) = fixture().await;
        let (status, view) = get(&app, Some(&alice)).await;
        assert_eq!(status, StatusCode::OK, "{view}");
        let entries = view["ceremonies"].as_array().unwrap();
        assert!(!entries.is_empty(), "an empty catalog makes everything C3");

        // Not anonymous. The Host API has no unauthenticated surface outside
        // /health, and checked-in data is not a reason to add the first one.
        let (status, _) = get(&app, None).await;
        assert_ne!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_row_names_what_may_be_captured_and_never_what_was() {
        let (app, alice) = fixture().await;
        let (_, view) = get(&app, Some(&alice)).await;
        let github = view["ceremonies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["provider_id"] == json!("github"))
            .expect("github is in the catalog");

        // Slot names, which is permission, not a value and not a receipt.
        let declares: Vec<&str> = github["declares"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(declares.contains(&"private_key"));
        assert_eq!(github["secrets_returned"], json!(false));

        // Nothing anywhere in the response looks like a captured value.
        let body = serde_json::to_string(&view).unwrap();
        assert!(!body.contains("-----BEGIN"), "a PEM reached the wire");
    }

    #[tokio::test]
    async fn registration_is_the_provider_s_own_endpoint_and_installing_is_not() {
        // The route's whole job is to carry ADR 0082 §1's decision out to a
        // client, so it is asserted here and not only in the crate: a client
        // reading `c0` for installation would drive a consent screen.
        let (app, alice) = fixture().await;
        let (_, view) = get(&app, Some(&alice)).await;
        let github = view["ceremonies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["provider_id"] == json!("github"))
            .expect("github is in the catalog");

        let tier_for = |phase: &str| -> String {
            github["plan"]
                .as_array()
                .unwrap()
                .iter()
                .find(|step| step["phase"] == json!(phase))
                .and_then(|step| step["tier"].as_str())
                .unwrap_or_default()
                .to_string()
        };
        assert_eq!(tier_for("registration"), Tier::ProviderNative.as_str());
        assert_eq!(tier_for("installation"), Tier::Blocked.as_str());
    }

    #[tokio::test]
    async fn the_wire_names_are_the_crate_s_own() {
        // A second spelling of the ladder is a second thing to keep in step
        // with ADR 0082, so the route is held to the crate's frozen names.
        let (app, alice) = fixture().await;
        let (_, view) = get(&app, Some(&alice)).await;
        let phases: Vec<&str> = view["phases"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(phases, Phase::ALL.map(Phase::as_str).to_vec());

        let known: Vec<&str> = Tier::ALL.iter().map(|tier| tier.as_str()).collect();
        let steps = view["ceremonies"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|entry| entry["plan"].as_array().unwrap().iter());
        for step in steps {
            let tier = step["tier"].as_str().unwrap();
            assert!(known.contains(&tier), "`{tier}` is not a tier");
        }
    }
}
