//! Admission attacks on the L2 path, one test per attack. These run the
//! admission both entry points share; the end-to-end suite in
//! `tests/constrained_http_e2e.rs` runs the broker behind it against a TLS
//! upstream.
//!
//! Ported from the placeholder simulation's suite, whose every refusal still
//! holds here: a foreign placeholder, a repeated one, a same-shape neighbour,
//! caller-named material and an unknown connection.

use super::*;
use opensesame_invoke_through::SurrogateSite;
use serde_json::Value;

const CALLER: &str = "demo-conn";
const CONNECTION: &str = "conn://acme/github";
const MATERIAL: &str = "CANARY-l2-material-never-leaves";
const REPO: &str = "https://api.github.com/repos/acme/x";

fn spec(connection_ref: &str, run: &str) -> SurrogateSpec {
    SurrogateSpec {
        provider_id: "github".into(),
        connection_ref: connection_ref.into(),
        run_id: run.into(),
        caller: CALLER.into(),
        site: SurrogateSite::Authorization,
        methods: vec!["GET".into(), "POST".into()],
        path_prefixes: vec!["/".into()],
        expires_at_unix: u64::MAX,
    }
}

fn host_with(spec: SurrogateSpec) -> (HostRuntime, String) {
    let mut host = HostRuntime::default();
    let surrogate = host
        .register_connection(spec, SecretString::from(MATERIAL))
        .expect("registered");
    (host, surrogate.as_str().to_string())
}

fn host() -> (HostRuntime, String) {
    host_with(spec(CONNECTION, "run-a"))
}

fn request(params: Value) -> InvokeRequest {
    InvokeRequest {
        operation: "http.authorized".into(),
        resource: "r".into(),
        audience: "https://api.github.com".into(),
        parameters_digest: opensesame_param_digest(&params),
        parameters: params,
        authorized_operation: "http.authorized".into(),
        invoke_level: Some(2),
        connection_ref: String::new(),
    }
}

fn bearer(placeholder: &str) -> Value {
    json!([["authorization", format!("Bearer {placeholder}")]])
}

/// A well-formed GET carrying `headers`, against the registered connection.
fn get(headers: &Value) -> Value {
    json!({"url": REPO, "connection_ref": CONNECTION, "headers": headers})
}

fn admit(host: &HostRuntime, params: Value) -> Result<(), HostError> {
    host.admit_constrained_http(CALLER, &request(params), now_unix(), None)
        .map(|_| ())
}

fn refused(host: &HostRuntime, params: Value) -> RefusalCode {
    match admit(host, params) {
        Err(HostError::SurrogateRefused(code)) => code,
        other => panic!("expected a surrogate refusal, got {other:?}"),
    }
}

#[test]
fn a_placeholder_at_its_declared_site_is_admitted() {
    let (host, ph) = host();
    admit(&host, get(&bearer(&ph))).expect("admitted");
    // `token` is the scheme older GitHub clients send.
    admit(
        &host,
        get(&json!([["Authorization", format!("token {ph}")]])),
    )
    .expect("admitted");
}

#[test]
fn the_synchronous_entry_point_never_reports_an_injection() {
    let (host, ph) = host();
    // Admitted, then refused: there is no broker to send it, and nothing may
    // claim a credential was placed on a request that was never sent.
    let placed = host.invoke(CALLER, &request(get(&bearer(&ph))));
    assert!(
        matches!(&placed, Err(HostError::Connector(m)) if m == NEEDS_BROKER),
        "{placed:?}"
    );
    // The simulation reported `credential_injected: true` for this one.
    let bare = host.invoke(
        CALLER,
        &request(json!({"url": REPO, "connection_ref": CONNECTION})),
    );
    assert_eq!(bare.unwrap_err(), HostError::PlaceholderMismatch);
}

#[test]
fn a_foreign_placeholder_is_refused() {
    let (host, ph) = host();
    let forged = format!("osr_{}", "0".repeat(32));
    assert_eq!(refused(&host, get(&bearer(&forged))), RefusalCode::Unknown);
    // Naming a placeholder other than the one carried is refused too.
    let mut named = get(&bearer(&ph));
    named["placeholder"] = json!(forged);
    assert_eq!(admit(&host, named), Err(HostError::PlaceholderMismatch));
    // The simulation's own shape selects nothing any more.
    let legacy = get(&bearer("ostest_someone_elses0"));
    assert_eq!(admit(&host, legacy), Err(HostError::PlaceholderMismatch));
}

#[test]
fn a_repeated_placeholder_is_refused() {
    let (host, ph) = host();
    let twice = get(&json!([["authorization", format!("Bearer {ph} {ph}")]]));
    assert_eq!(refused(&host, twice), RefusalCode::Misplaced);
    let two_headers = get(&json!([
        ["authorization", format!("Bearer {ph}")],
        ["authorization", format!("Bearer {ph}")],
    ]));
    assert_eq!(refused(&host, two_headers), RefusalCode::Misplaced);
}

#[test]
fn a_decorated_placeholder_is_refused() {
    // The simulation passed this: one occurrence, in the allowed header.
    let (host, ph) = host();
    let decorated = get(&json!([["authorization", format!("Bearer {ph}.exfil")]]));
    assert_eq!(refused(&host, decorated), RefusalCode::Misplaced);
    let basic = get(&json!([["authorization", format!("Basic {ph}")]]));
    assert_eq!(refused(&host, basic), RefusalCode::Misplaced);
}

#[test]
fn a_same_shape_neighbour_is_refused() {
    let (mut host, _) = host();
    let neighbour = host
        .register_connection(
            spec("conn://acme/other", "run-b"),
            SecretString::from("CANARY-neighbour"),
        )
        .expect("registered");
    // Issued by this host, well placed, and still not this connection's.
    let crossed = get(&bearer(neighbour.as_str()));
    assert_eq!(refused(&host, crossed), RefusalCode::Unknown);
}

#[test]
fn a_caller_naming_material_is_refused() {
    let (host, ph) = host();
    let mut params = get(&bearer(&ph));
    params["material"] = json!("attacker-chosen");
    let err = host.invoke(CALLER, &request(params)).unwrap_err();
    assert_eq!(err, HostError::MaterializeDenied);
}

#[test]
fn an_unknown_connection_is_refused() {
    let (host, ph) = host();
    // Naming a connection this host holds nothing for, with a placeholder it
    // did issue, confirms nothing: the answer is the placeholder refusal.
    let params = json!({"url": REPO, "connection_ref": "conn://not-mine", "headers": bearer(&ph)});
    assert_eq!(refused(&host, params), RefusalCode::Unknown);
    let without = json!({"url": REPO, "connection_ref": "conn://not-mine"});
    assert_eq!(admit(&host, without), Err(HostError::PlaceholderMismatch));
}

#[test]
fn a_placeholder_in_the_body_is_refused() {
    let (host, ph) = host();
    let params = json!({
        "url": REPO, "method": "POST", "connection_ref": CONNECTION,
        "body_field": "message", "body_value": format!("exfil {ph}"),
    });
    assert_eq!(refused(&host, params), RefusalCode::Misplaced);
}

#[test]
fn a_placeholder_in_the_body_beside_a_valid_header_is_refused() {
    // The gist oracle: a valid header authorizes the call, and the body
    // would be read back. Nothing is ever written into the body, so the
    // placeholder there is refused rather than left to redeem.
    let (host, ph) = host();
    let params = json!({
        "url": "https://api.github.com/gists", "method": "POST", "connection_ref": CONNECTION,
        "headers": bearer(&ph), "body": format!("{{\"content\":\"{ph}\"}}"),
    });
    assert_eq!(refused(&host, params), RefusalCode::Misplaced);
}

#[test]
fn a_placeholder_in_the_query_is_refused() {
    let (host, ph) = host();
    let params = json!({
        "url": format!("{REPO}?note={ph}"), "connection_ref": CONNECTION, "headers": bearer(&ph),
    });
    assert_eq!(refused(&host, params), RefusalCode::Misplaced);
}

#[test]
fn a_placeholder_sent_off_its_providers_hosts_is_refused() {
    // github.com passes the host policy but is not on the provider's rule.
    let (host, ph) = host();
    let params = json!({
        "url": "https://github.com/acme/x", "connection_ref": CONNECTION, "headers": bearer(&ph),
    });
    assert_eq!(refused(&host, params), RefusalCode::Misdirected);
}

#[test]
fn a_placeholder_from_another_connector_binding_is_refused() {
    let (mut host, ph) = host();
    host.bind_connection("other-conn", "mock").expect("bound");
    let err = host
        .invoke("other-conn", &request(get(&bearer(&ph))))
        .unwrap_err();
    assert_eq!(err, HostError::SurrogateRefused(RefusalCode::ForeignCaller));
}

#[test]
fn a_placeholder_from_an_ended_run_is_refused() {
    let (mut host, ph) = host();
    assert_eq!(host.revoke_run("run-a"), 1);
    assert_eq!(refused(&host, get(&bearer(&ph))), RefusalCode::Revoked);
    // Registering the connection again issues a new placeholder; the old one
    // stays dead.
    let fresh = host
        .register_connection(spec(CONNECTION, "run-c"), SecretString::from(MATERIAL))
        .expect("registered again");
    assert_ne!(fresh.as_str(), ph);
    assert_eq!(refused(&host, get(&bearer(&ph))), RefusalCode::Revoked);
    admit(&host, get(&bearer(fresh.as_str()))).expect("the new one works");
}

#[test]
fn an_expired_placeholder_is_refused() {
    let (host, ph) = host_with(SurrogateSpec {
        expires_at_unix: 1,
        ..spec(CONNECTION, "run-a")
    });
    assert_eq!(refused(&host, get(&bearer(&ph))), RefusalCode::Expired);
}

#[test]
fn a_placeholder_outside_its_scope_is_refused() {
    let (host, ph) = host_with(SurrogateSpec {
        path_prefixes: vec!["/repos/acme/x".into()],
        ..spec(CONNECTION, "run-a")
    });
    let mut delete = get(&bearer(&ph));
    delete["method"] = json!("DELETE");
    assert_eq!(refused(&host, delete), RefusalCode::OutOfScope);
    let climb = json!({
        "url": "https://api.github.com/repos/acme/x/../../other", "connection_ref": CONNECTION,
        "headers": bearer(&ph),
    });
    assert_eq!(refused(&host, climb), RefusalCode::OutOfScope);
}

#[test]
fn a_second_credential_header_beside_a_named_site_is_refused() {
    let (host, ph) = host_with(SurrogateSpec {
        site: SurrogateSite::Header("x-api-key".into()),
        ..spec(CONNECTION, "run-a")
    });
    // The placeholder's header is stripped; an Authorization of the caller's
    // own is not forwarded beside the one the broker writes.
    let params = get(&json!([
        ["x-api-key", ph],
        ["authorization", "Bearer mine"]
    ]));
    assert!(matches!(admit(&host, params), Err(HostError::Connector(_))));
}

#[test]
fn an_intent_whose_parameters_changed_is_refused() {
    let (host, ph) = host();
    let mut req = request(get(&bearer(&ph)));
    req.parameters["url"] = json!("https://api.github.com/repos/acme/other");
    let err = host.invoke(CALLER, &req).unwrap_err();
    assert_eq!(err, HostError::ParameterDigestMismatch);
}

#[test]
fn the_default_host_holds_no_connection() {
    let host = HostRuntime::default();
    let forged = format!("osr_{}", "a".repeat(32));
    assert_eq!(refused(&host, get(&bearer(&forged))), RefusalCode::Unknown);
}

#[test]
fn every_refusal_tells_the_client_one_message() {
    for code in [
        RefusalCode::Ambiguous,
        RefusalCode::Unknown,
        RefusalCode::Revoked,
        RefusalCode::Expired,
        RefusalCode::ForeignCaller,
        RefusalCode::Misdirected,
        RefusalCode::Cleartext,
        RefusalCode::Misplaced,
        RefusalCode::OutOfScope,
    ] {
        assert_eq!(
            HostError::SurrogateRefused(code).to_string(),
            Refusal::CLIENT_MESSAGE
        );
    }
}

#[test]
fn debug_never_prints_the_placeholder_or_the_material() {
    let (host, ph) = host();
    let rendered = format!("{host:?}");
    assert!(!rendered.contains(&ph), "{rendered}");
    assert!(!rendered.contains(MATERIAL), "{rendered}");
}
