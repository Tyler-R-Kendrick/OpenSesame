//! A copied pre-upgrade bearer never regains access after the daemon upgrade.
use super::tests::{call, extension_headers, request, store, EXT, TOKEN};
use super::*;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn legacy_profile_bearers_are_refused_before_and_after_repairing() {
    let dir = tempfile::tempdir().unwrap();
    // Exactly the old persisted representation, including its approved digest.
    let legacy = json!({
        "v": 1,
        "pairings": [{
            "origin": EXT,
            "token_sha256": hex::encode(Sha256::digest(TOKEN.as_bytes())),
            "paired_at": chrono::Utc::now(),
        }],
    });
    std::fs::write(
        dir.path().join(pairing::PAIRINGS_FILE),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let state = Arc::new(FillState::new(
        Box::new(store()),
        Some(dir.path()),
        Arc::new(gate::Fixed(true)),
    ));
    let st = crate::tests::test_state("http://127.0.0.1:1");
    let app = routes(Arc::clone(&state), &st).with_state(st.clone());
    let headers = extension_headers();
    let borrowed: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let body = json!({
        "reference": "Web/example.com", "origin": "https://example.com", "field": "password",
    });
    for path in ["/v1/fill/match", "/v1/fill"] {
        let body = if path.ends_with("/match") {
            json!({ "origin": "https://example.com" })
        } else {
            body.clone()
        };
        let (status, _, json) = call(&app, request(path, &body, &borrowed)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "legacy bearer at {path}");
        assert_eq!(json["error"], "not_paired");
    }
    // Replaying the old bearer to /pair can only open a new pending ceremony.
    let (status, _, pending) = call(&app, request("/v1/fill/pair", &json!({}), &borrowed)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(pending["state"], "pending");

    let fresh = "B".repeat(43);
    let PairOutcome::Pending { code, .. } = state.pairings.request(EXT, &fresh, chrono::Utc::now())
    else {
        panic!("fresh session needs approval");
    };
    state.pairings.approve(&code, chrono::Utc::now()).unwrap();
    let authorization = format!("Bearer {fresh}");
    let fresh_headers = [
        ("host", "127.0.0.1:18790"),
        ("origin", EXT),
        ("authorization", authorization.as_str()),
    ];
    for path in ["/v1/fill/match", "/v1/fill"] {
        let body = if path.ends_with("/match") {
            json!({ "origin": "https://example.com" })
        } else {
            body.clone()
        };
        let (status, _, _) = call(&app, request(path, &body, &fresh_headers)).await;
        assert_eq!(status, StatusCode::OK, "fresh approved session at {path}");
        let (status, _, _) = call(&app, request(path, &body, &borrowed)).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "old token remains dead at {path}"
        );
    }
    let reloaded = Pairings::load(Some(dir.path()));
    assert!(!reloaded.verify(EXT, TOKEN));
    assert!(
        reloaded.verify(EXT, &fresh),
        "a daemon restart keeps the live browser session paired"
    );
}
