use std::path::PathBuf;

use super::daemon::{
    assert_tcp_listen_allowed, listen_host_is_loopback, ENV_ALLOW_NONLOCAL,
    ENV_ALLOW_NONLOCAL_DAEMON,
};
use super::http_security::{assert_cors_origins_allowed, parse_cors_origins};

#[test]
fn wit_package_pinned() {
    assert!(super::wit_contract::PACKAGE.contains("host"));
}

#[test]
fn forwarding_headers_are_treated_as_hop_headers() {
    use super::http_security::{is_hop_or_forwarding_header, is_safe_path_id};
    assert!(is_hop_or_forwarding_header("X-Forwarded-For"));
    assert!(is_hop_or_forwarding_header("forwarded"));
    assert!(is_hop_or_forwarding_header("X-Real-IP"));
    assert!(!is_hop_or_forwarding_header("authorization"));
    assert!(is_safe_path_id("clm_abc12345"));
    assert!(!is_safe_path_id("../etc/passwd"));
    assert!(!is_safe_path_id("id?x=1"));
    assert!(!is_safe_path_id("id#frag"));
}

#[test]
fn pact_oracles_kill_check_then_set_and_require_source_order() {
    super::pact::exclusive_claim_is_single_winner();
    super::pact::check_then_set_admits_double_claim();
    super::pact::assert_source_order(
        "alpha(); beta(); gamma();",
        &["alpha()", "beta()", "gamma()"],
    );
    // A marker that also appears earlier still counts after the previous step.
    super::pact::assert_source_order(
        "append_outbox(early); pub async fn resync; append_outbox(late);",
        &["pub async fn resync", "append_outbox("],
    );
}

#[test]
fn a_local_base_url_is_told_apart_from_a_remote_one() {
    use super::daemon::base_url_is_local;
    for local in [
        "http://127.0.0.1:8787",
        "http://localhost:8787/api",
        "https://LOCALHOST",
        "http://[::1]:18790",
    ] {
        assert!(base_url_is_local(local), "{local} names this machine");
    }
    for remote in [
        "http://10.0.0.5:8787",
        "https://api.example.test",
        // Userinfo: the authority is evil.test, whatever it is dressed as.
        "http://127.0.0.1@evil.test/api",
        "http://localhost.evil.test",
        // Not an http(s) base at all.
        "ftp://127.0.0.1",
        "127.0.0.1:8787",
        "",
    ] {
        assert!(!base_url_is_local(remote), "{remote} is not this machine");
    }
}

#[test]
fn loopback_listen_hosts() {
    assert!(listen_host_is_loopback("127.0.0.1:18790"));
    assert!(listen_host_is_loopback("localhost:18790"));
    assert!(listen_host_is_loopback("[::1]:18790"));
    assert!(!listen_host_is_loopback("0.0.0.0:18790"));
    assert!(!listen_host_is_loopback("192.168.1.10:18790"));
}

#[test]
fn nonlocal_tcp_denied_without_override() {
    // Ensure override unset for this process check.
    std::env::remove_var(ENV_ALLOW_NONLOCAL);
    std::env::remove_var(ENV_ALLOW_NONLOCAL_DAEMON);
    assert!(assert_tcp_listen_allowed("127.0.0.1:18790").is_ok());
    assert!(assert_tcp_listen_allowed("0.0.0.0:18790").is_err());
}

#[test]
fn cors_defaults_are_empty_and_explicit_origins_are_not_expanded() {
    assert!(parse_cors_origins(None).is_empty());
    assert_eq!(
        parse_cors_origins(Some("https://app.example, https://ops.example")),
        vec!["https://app.example", "https://ops.example"]
    );
    assert!(assert_cors_origins_allowed(&[], true).is_ok());
}

#[test]
fn cors_rejects_noncanonical_or_opaque_origins() {
    for origin in [
        "*",
        "null",
        "https://app.example/path",
        "https://app.example/",
        "http://remote.example",
        "https://user@app.example",
        "https://app.example.",
        "https://APP.example",
        "https://app.example:443",
        "https://app.example?x=1",
    ] {
        assert!(
            assert_cors_origins_allowed(&[origin.into()], false).is_err(),
            "{origin}"
        );
    }
    for origin in [
        "https://app.example",
        "http://127.0.0.1:5180",
        "http://[::1]:5180",
    ] {
        assert!(
            assert_cors_origins_allowed(&[origin.into()], true).is_ok(),
            "{origin}"
        );
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read_wit(rel: &str) -> String {
    std::fs::read_to_string(repo_root().join(rel))
        .unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
}

fn assert_no_secrets_or_arbitrary_sign(src: &str) {
    let code: String = src
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    assert!(
        !code.contains("secrets.get"),
        "WIT must not expose secrets.get"
    );
    assert!(
        !code.contains("sign: func(") || code.contains("purpose:"),
        "sign must be purpose-bound if present"
    );
}

#[test]
fn wit_task_contract() {
    let src = read_wit("wit/task/world.wit");
    assert_no_secrets_or_arbitrary_sign(&src);
    assert!(src.contains("authorize-and-invoke"));
    assert!(src.contains("restrict"));
    assert!(src.contains("terminate"));
    assert!(src.contains("task-handle"));
    assert!(src.contains("intent-handle"));
}

#[test]
fn wit_proof_contract() {
    let src = read_wit("wit/proof/world.wit");
    assert_no_secrets_or_arbitrary_sign(&src);
    assert!(src.contains("execute-authorized-proof"));
    assert!(src.contains("task-run-id"));
    assert!(src.contains("intent-digest"));
}

#[test]
fn wit_mediation_contract() {
    let src = read_wit("wit/mediation/world.wit");
    assert_no_secrets_or_arbitrary_sign(&src);
    assert!(src.contains("classify-result"));
    assert!(src.contains("acknowledge-transition"));
}

#[test]
fn host_wit_unchanged_exports() {
    let src = read_wit("wit/host/world.wit");
    assert!(src.contains("export session"));
    assert!(src.contains("export invoke"));
    assert!(src.contains("opensesame:host@1.0.0"));
}
