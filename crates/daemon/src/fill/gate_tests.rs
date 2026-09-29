//! The plugin switch (ADR 0150 §7): one test per way the fill routes could
//! answer while `browser-autofill` is not switched on.
use super::gate::{Fixed, PluginGate, SettingsGate, PLUGIN_ID};
use super::tests::{extension_headers, fill, paired_app_behind, store};
use super::*;
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request},
};
use opensesame_plugin_settings::PluginSettings;
use serde_json::Value;
use tower::ServiceExt;

const PIN: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Every route this module serves, and one it never did.
const FILL_PATHS: [&str; 6] = [
    "/v1/fill",
    "/v1/fill/match",
    "/v1/fill/pair",
    "/v1/fill/pair/approve",
    "/v1/fill/pair/revoke",
    "/v1/fill/pairings",
];
const NEVER_SERVED: &str = "/v1/fill-was-never-a-route";

/// Status, headers and body bytes: everything a caller can observe.
async fn observe(
    app: &Router,
    method: Method,
    path: &str,
    authorized: bool,
) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if authorized {
        for (name, value) in extension_headers() {
            builder = builder.header(name, value);
        }
        builder = builder.header("x-opensesame-operator", crate::test_operator_token());
    }
    let body = json!({ "reference": "Web/example.com", "origin": "https://example.com", "field": "password" });
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let mut headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(n, v)| (n.to_string(), v.to_str().unwrap_or_default().to_string()))
        .collect();
    headers.sort();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, headers, bytes.to_vec())
}

#[tokio::test]
async fn a_switched_off_plugin_is_indistinguishable_from_no_route() {
    let app = paired_app_behind(store(), Arc::new(Fixed(false)));
    let methods = [Method::GET, Method::POST, Method::PUT, Method::DELETE];
    let cases = [true, false]
        .into_iter()
        .flat_map(|authorized| methods.iter().map(move |m| (authorized, m.clone())));
    for (authorized, method) in cases {
        let absent = observe(&app, method.clone(), NEVER_SERVED, authorized).await;
        assert_eq!(absent.0, StatusCode::NOT_FOUND);
        for path in FILL_PATHS {
            let seen = observe(&app, method.clone(), path, authorized).await;
            assert_eq!(seen, absent, "{method} {path} (authorized: {authorized})");
        }
    }
}

#[tokio::test]
async fn a_switched_on_plugin_answers() {
    let app = paired_app_behind(store(), Arc::new(Fixed(true)));
    let (status, _) = fill(&app, "Web/example.com", "https://example.com", "password").await;
    assert_eq!(status, StatusCode::OK);
}

/// A settings file at `dir` recording `browser-autofill` as given.
fn settings_file(dir: &std::path::Path, installed: bool, enabled: bool) -> std::path::PathBuf {
    let path = dir.join("plugins.json");
    let mut settings = PluginSettings::load(&path).unwrap();
    if installed {
        settings
            .record_install(PLUGIN_ID, "0.1.0", PIN, "chrome-extension-id")
            .unwrap();
        settings.set_enabled(PLUGIN_ID, enabled).unwrap();
    }
    settings.save(&path).unwrap();
    path
}

fn no_env(_: &str) -> Option<String> {
    None
}

async fn fill_status(gate: SettingsGate) -> StatusCode {
    let app = paired_app_behind(store(), Arc::new(gate));
    fill(&app, "Web/example.com", "https://example.com", "password")
        .await
        .0
}

#[tokio::test]
async fn an_uninstalled_plugin_does_not_fill() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("plugins.json");
    assert_eq!(
        fill_status(SettingsGate::at(missing, no_env)).await,
        StatusCode::NOT_FOUND
    );
    let empty = settings_file(dir.path(), false, false);
    assert_eq!(
        fill_status(SettingsGate::at(empty, no_env)).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn an_installed_plugin_left_off_does_not_fill() {
    let dir = tempfile::tempdir().unwrap();
    let path = settings_file(dir.path(), true, false);
    assert_eq!(
        fill_status(SettingsGate::at(path, no_env)).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn the_plugin_switched_on_in_settings_fills() {
    let dir = tempfile::tempdir().unwrap();
    let path = settings_file(dir.path(), true, true);
    assert_eq!(
        fill_status(SettingsGate::at(path, no_env)).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn the_environment_forces_a_switched_on_plugin_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = settings_file(dir.path(), true, true);
    let forced = |key: &str| (key == "OPENSESAME_PLUGIN_BROWSER_AUTOFILL").then(|| "off".into());
    assert_eq!(
        fill_status(SettingsGate::at(path, forced)).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn no_environment_value_switches_the_plugin_on() {
    let dir = tempfile::tempdir().unwrap();
    let path = settings_file(dir.path(), true, false);
    let pushy = |_: &str| Some("on".to_string());
    assert_eq!(
        fill_status(SettingsGate::at(path, pushy)).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn a_malformed_settings_file_does_not_fill() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plugins.json");
    std::fs::write(
        &path,
        br#"{"schema_version":1,"plugins":{"browser-autofill":"#,
    )
    .unwrap();
    assert!(!SettingsGate::at(path.clone(), no_env).active());
    assert_eq!(
        fill_status(SettingsGate::at(path, no_env)).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn switching_the_plugin_off_stops_the_very_next_fill() {
    let dir = tempfile::tempdir().unwrap();
    let path = settings_file(dir.path(), true, true);
    let app = paired_app_behind(store(), Arc::new(SettingsGate::at(path.clone(), no_env)));
    let first = fill(&app, "Web/example.com", "https://example.com", "password").await;
    assert_eq!(first.0, StatusCode::OK);
    let mut settings = PluginSettings::load(&path).unwrap();
    settings.set_enabled(PLUGIN_ID, false).unwrap();
    settings.save(&path).unwrap();
    let next = fill(&app, "Web/example.com", "https://example.com", "password").await;
    assert_eq!(next.0, StatusCode::NOT_FOUND);
    assert_eq!(next.1, Value::Null);
}

/// What a client on the socket sees: status, headers but `date`, body.
async fn over_the_wire(
    base: &str,
    method: reqwest::Method,
    path: &str,
) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let response = reqwest::Client::new()
        .request(method, format!("{base}{path}"))
        .header("origin", super::tests::EXT)
        .header("authorization", format!("Bearer {}", super::tests::TOKEN))
        .json(&json!({ "origin": "https://example.com" }))
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let mut headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .filter(|(name, _)| *name != "date")
        .map(|(n, v)| (n.to_string(), v.to_str().unwrap_or_default().to_string()))
        .collect();
    headers.sort();
    (status, headers, response.bytes().await.unwrap().to_vec())
}

#[tokio::test]
async fn a_switched_off_plugin_is_indistinguishable_over_the_wire() {
    let st = crate::tests::test_state("http://127.0.0.1:1");
    let off = Arc::new(FillState::new(
        Box::new(store()),
        None,
        Arc::new(Fixed(false)),
    ));
    let app = opensesame_host_core::http_security::apply_http_security(
        Router::new()
            .route("/health", axum::routing::get(|| async { "ok" }))
            .merge(routes(off, &st))
            .with_state(st),
        &[],
        false,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    for method in [
        reqwest::Method::GET,
        reqwest::Method::POST,
        reqwest::Method::PUT,
    ] {
        let absent = over_the_wire(&base, method.clone(), NEVER_SERVED).await;
        assert_eq!(absent.0, 404);
        for path in FILL_PATHS {
            let seen = over_the_wire(&base, method.clone(), path).await;
            assert_eq!(seen, absent, "{method} {path}");
        }
    }
}
