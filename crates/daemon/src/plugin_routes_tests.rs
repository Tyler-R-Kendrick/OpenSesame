use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use opensesame_plugin_settings::{sha256_file, NOTICES_FILE, TRIPWIRES_FILE};
use tower::ServiceExt;

const SURROGATE: &str = "osr_0123456789abcdef0123456789abcdef";

struct Fixture {
    dir: tempfile::TempDir,
    app: Router,
}

impl Fixture {
    fn settings(&self) -> PathBuf {
        self.dir.path().join("plugins.json")
    }

    fn notices(&self, id: &str) -> PathBuf {
        notices_path(&self.settings(), id).unwrap()
    }
}

fn fixture_with_env(env: EnvReader) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let mut state = crate::tests::test_state("http://127.0.0.1:1");
    state.plugins = PluginHost::at(Some(dir.path().join("plugins.json")), env);
    Fixture {
        dir,
        app: routes(&state).with_state(state.clone()),
    }
}

fn fixture() -> Fixture {
    fixture_with_env(Arc::new(|_| None))
}

fn install(fixture: &Fixture, id: &str) {
    let bin = fixture.dir.path().join(format!("{id}.bin"));
    std::fs::write(&bin, b"plugin").unwrap();
    let mut settings = PluginSettings::load(&fixture.settings()).unwrap();
    let pin = sha256_file(&bin).unwrap();
    settings
        .record_install(id, "0.1.0", &pin, bin.to_str().unwrap())
        .unwrap();
    settings.save(&fixture.settings()).unwrap();
}

fn request(method: &str, uri: &str, body: Option<&Value>, operator: bool) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if operator {
        builder = builder.header("x-opensesame-operator", crate::test_operator_token());
    }
    builder
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap()
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn enable(on: bool) -> Value {
    json!({ "enabled": on })
}

#[tokio::test]
async fn every_plugin_route_refuses_a_caller_without_the_operator_token() {
    let f = fixture();
    install(&f, "surrogate-proxy");
    for (method, uri, body) in [
        ("GET", "/v1/plugins", None),
        ("PUT", "/v1/plugins/surrogate-proxy", Some(enable(true))),
        ("GET", "/v1/plugins/surrogate-proxy/notices", None),
    ] {
        let (status, _) = call(&f.app, request(method, uri, body.as_ref(), false)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    let settings = PluginSettings::load(&f.settings()).unwrap();
    assert!(!settings.plugins["surrogate-proxy"].enabled);
}

#[tokio::test]
async fn a_browser_origin_cannot_switch_a_plugin_on_even_with_the_token() {
    let f = fixture();
    install(&f, "surrogate-proxy");
    let mut req = request(
        "PUT",
        "/v1/plugins/surrogate-proxy",
        Some(&enable(true)),
        true,
    );
    req.headers_mut()
        .insert("origin", "http://localhost:5180".parse().unwrap());
    let (status, _) = call(&f.app, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(!PluginSettings::load(&f.settings()).unwrap().plugins["surrogate-proxy"].enabled);
}

#[tokio::test]
async fn the_list_is_the_catalog_in_order_and_nothing_is_on_by_default() {
    let f = fixture();
    let (status, body) = call(&f.app, request("GET", "/v1/plugins", None, true)).await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = body["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    let catalog_ids: Vec<String> = catalog().into_iter().map(|p| p.id).collect();
    assert_eq!(ids, catalog_ids);
    for plugin in body["plugins"].as_array().unwrap() {
        assert_eq!(plugin["installed"], false);
        assert_eq!(plugin["active"], false);
    }
}

#[tokio::test]
async fn an_unknown_plugin_id_is_a_bad_request_not_a_path() {
    let f = fixture();
    for (method, uri) in [
        ("PUT", "/v1/plugins/..%2F..%2Fetc"),
        ("PUT", "/v1/plugins/not-a-plugin"),
        ("GET", "/v1/plugins/not-a-plugin/notices"),
        ("GET", "/v1/plugins/..%2Fsurrogate-proxy/notices"),
    ] {
        let body = (method == "PUT").then(|| enable(true));
        let (status, json) = call(&f.app, request(method, uri, body.as_ref(), true)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {uri}");
        assert_eq!(json["error"], "unknown_plugin");
    }
}

#[tokio::test]
async fn switching_on_a_plugin_nobody_installed_is_not_found() {
    let f = fixture();
    let (status, json) = call(
        &f.app,
        request(
            "PUT",
            "/v1/plugins/surrogate-proxy",
            Some(&enable(true)),
            true,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json["error"], "not_installed");
    assert!(PluginSettings::load(&f.settings())
        .unwrap()
        .plugins
        .is_empty());
}

#[tokio::test]
async fn enable_and_disable_round_trip_through_the_settings_file() {
    let f = fixture();
    install(&f, "surrogate-proxy");
    let put = |on| {
        request(
            "PUT",
            "/v1/plugins/surrogate-proxy",
            Some(&enable(on)),
            true,
        )
    };
    let (status, state) = call(&f.app, put(true)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["enabled"], true);
    assert_eq!(state["active"], true);
    assert!(PluginSettings::load(&f.settings()).unwrap().plugins["surrogate-proxy"].enabled);
    let (_, state) = call(&f.app, put(false)).await;
    assert_eq!(state["active"], false);
    assert!(!PluginSettings::load(&f.settings()).unwrap().plugins["surrogate-proxy"].enabled);
}

#[tokio::test]
async fn a_toggle_with_an_extra_field_is_refused_and_writes_nothing() {
    let f = fixture();
    install(&f, "surrogate-proxy");
    let body = json!({ "enabled": true, "sha256": "0".repeat(64) });
    let (status, _) = call(
        &f.app,
        request("PUT", "/v1/plugins/surrogate-proxy", Some(&body), true),
    )
    .await;
    assert!(status.is_client_error(), "{status}");
    let settings = PluginSettings::load(&f.settings()).unwrap();
    assert!(!settings.plugins["surrogate-proxy"].enabled);
    assert_ne!(settings.plugins["surrogate-proxy"].sha256, "0".repeat(64));
}

#[tokio::test]
async fn an_environment_force_off_shows_as_forced_off_and_inactive() {
    let f = fixture_with_env(Arc::new(|key: &str| {
        (key == "OPENSESAME_PLUGIN_SURROGATE_PROXY").then(|| "off".to_owned())
    }));
    install(&f, "surrogate-proxy");
    let (_, state) = call(
        &f.app,
        request(
            "PUT",
            "/v1/plugins/surrogate-proxy",
            Some(&enable(true)),
            true,
        ),
    )
    .await;
    assert_eq!(state["enabled"], true);
    assert_eq!(state["forced_off"], true);
    assert_eq!(state["active"], false);
}

fn notice(n: usize, summary: &str) -> String {
    json!({
        "event_type": "surrogate.misdirected",
        "severity": "error",
        "state": "firing",
        "organization_id": "local",
        "subject_kind": "agent_run",
        "subject_id": format!("run-{n}"),
        "occurred_at": format!("2026-09-28T00:00:{:02}Z", n % 60),
        "summary": summary,
        "payload": { "surrogate_included": false },
    })
    .to_string()
}

#[tokio::test]
async fn notices_never_carry_a_surrogate_even_when_the_file_does() {
    let f = fixture();
    let file = f.notices("surrogate-proxy");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let lines = [
        notice(
            1,
            "a surrogate for github was sent to a host its provider does not use",
        ),
        notice(2, &format!("planted {SURROGATE}")),
        notice(3, "planted OSR_0123456789ABCDEF0123456789ABCDEF"),
        "not json".to_owned(),
    ];
    std::fs::write(&file, lines.join("\n")).unwrap();
    let (status, body) = call(
        &f.app,
        request("GET", "/v1/plugins/surrogate-proxy/notices", None, true),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let text = body.to_string();
    assert!(!text.to_ascii_lowercase().contains("osr_"), "{text}");
    let notices = body["notices"].as_array().unwrap();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["subject_id"], "run-1");
    assert!(notices[0].get("payload").is_none());
}

#[tokio::test]
async fn notices_are_newest_first_capped_and_read_across_rotation() {
    let f = fixture();
    let file = f.notices("surrogate-proxy");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let old: Vec<String> = (0..30).map(|n| notice(n, "older")).collect();
    let new: Vec<String> = (30..60).map(|n| notice(n, "newer")).collect();
    std::fs::write(file.with_file_name(NOTICES_ROTATED_FILE), old.join("\n")).unwrap();
    std::fs::write(&file, new.join("\n")).unwrap();
    let (_, body) = call(
        &f.app,
        request("GET", "/v1/plugins/surrogate-proxy/notices", None, true),
    )
    .await;
    let notices = body["notices"].as_array().unwrap();
    assert_eq!(notices.len(), MAX_NOTICES);
    assert_eq!(notices[0]["subject_id"], "run-59");
    assert_eq!(notices[29]["subject_id"], "run-30");
    assert_eq!(notices[30]["subject_id"], "run-29");
    assert_eq!(file.file_name().unwrap(), NOTICES_FILE);
}

#[tokio::test]
async fn a_plugin_with_no_notices_file_has_no_notices() {
    let f = fixture();
    let (status, body) = call(
        &f.app,
        request("GET", "/v1/plugins/browser-autofill/notices", None, true),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "notices": [] }));
}

#[tokio::test]
async fn with_no_settings_location_the_routes_say_so_rather_than_guess() {
    let mut state = crate::tests::test_state("http://127.0.0.1:1");
    state.plugins = PluginHost::at(None, Arc::new(|_| None));
    let app = routes(&state).with_state(state);
    let (status, json) = call(&app, request("GET", "/v1/plugins", None, true)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json["error"], "plugin_settings_unavailable");
}

#[tokio::test]
async fn switching_on_a_binary_changed_since_install_is_refused_and_left_off() {
    let f = fixture();
    install(&f, "surrogate-proxy");
    std::fs::write(f.dir.path().join("surrogate-proxy.bin"), b"swapped").unwrap();
    let (status, json) = call(
        &f.app,
        request(
            "PUT",
            "/v1/plugins/surrogate-proxy",
            Some(&enable(true)),
            true,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(json["error"], "pin_mismatch");
    assert!(!PluginSettings::load(&f.settings()).unwrap().plugins["surrogate-proxy"].enabled);
}

fn info_notice(n: usize) -> String {
    json!({
        "event_type": "surrogate.unknown",
        "severity": "info",
        "state": "firing",
        "organization_id": "local",
        "subject_kind": "agent_run",
        "subject_id": format!("noise-{n}"),
        "occurred_at": format!("2026-09-28T01:00:{:02}Z", n % 60),
        "summary": "a value shaped like a surrogate was not issued by this run",
        "payload": { "surrogate_included": false },
    })
    .to_string()
}

#[tokio::test]
async fn a_tripwire_outlives_any_amount_of_noise_in_what_settings_shows() {
    let f = fixture();
    let file = f.notices("surrogate-proxy");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        file.with_file_name(TRIPWIRES_FILE),
        notice(1, "a surrogate for github was sent to evil.test"),
    )
    .unwrap();
    let noise: Vec<String> = (0..500).map(info_notice).collect();
    std::fs::write(&file, noise.join("\n")).unwrap();
    let (status, body) = call(
        &f.app,
        request("GET", "/v1/plugins/surrogate-proxy/notices", None, true),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let notices = body["notices"].as_array().unwrap();
    assert_eq!(notices.len(), MAX_NOTICES);
    assert_eq!(notices[0]["event_type"], "surrogate.misdirected");
    assert_eq!(notices[0]["severity"], "error");
    assert_eq!(notices[1]["event_type"], "surrogate.unknown");
}
