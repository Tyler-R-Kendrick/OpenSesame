use super::*;
#[cfg(unix)]
use crate::dev_run::login::tests::SECRET;
use crate::dev_run::login::tests::{web_login, FakeStore};
use opensesame_domain::{
    CredentialDeliveryMode, LegacyProjection, PlaceholderLocation, PlaceholderPlacement,
};
use opensesame_plugin_settings::sha256_file;
use serde_json::json;

pub(crate) fn placeholder(key: &str, uri: &str) -> ResolvedEnvEntry {
    let projection = LegacyProjection {
        env_var: key.into(),
        connection_ref_uri: uri.into(),
        placeholder_pattern: "ostest_*".into(),
        issued_placeholder: Some("ostest_0123456789".into()),
        placement: PlaceholderPlacement::default(),
        delivery: CredentialDeliveryMode::Placeholder,
    };
    ResolvedEnvEntry {
        key: key.into(),
        delivery: CredentialDeliveryMode::Placeholder,
        env_value: Some("ostest_0123456789".into()),
        connection_ref: Some(uri.into()),
        projection: Some(projection),
        omitted: false,
        warning: None,
        login: None,
        path_prefixes: Vec::new(),
    }
}

/// A store that must never be read: API-only runs touch no password.
pub(crate) struct NoStore;

impl LoginSource for NoStore {
    fn read(&self, _: &str) -> anyhow::Result<crate::dev_run::login::StoredLogin> {
        panic!("an API-only run read the sealed store");
    }
}

pub(crate) fn no_env(_: &str) -> Option<String> {
    None
}

/// A stand-in plugin: records the spec it was sent, answers with a
/// surrogate, and marks when its stdin closed.
const FAKE_PLUGIN: &str = r#"#!/bin/sh
here="$(dirname "$0")"
IFS= read -r line
printf '%s\n' "$line" > "$here/spec.json"
printf '%s\n' '{"proxy_url":"http://u:p@127.0.0.1:9","ca_pem_path":"/run/ca.pem","env":{"GITHUB_TOKEN":"osr_00000000000000000000000000000000","HTTPS_PROXY":"http://u:p@127.0.0.1:9"},"unserved":["OTHER"]}'
cat > /dev/null
: > "$here/ended"
"#;

pub(crate) struct Plugin {
    pub(crate) dir: tempfile::TempDir,
    pub(crate) settings: std::path::PathBuf,
}

pub(crate) fn installed(script: &str, enabled: bool, pin: Option<&str>) -> Plugin {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("opensesame-surrogate-proxy");
    std::fs::write(&bin, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let pin = pin.map_or_else(|| sha256_file(&bin).unwrap(), str::to_owned);
    let settings = dir.path().join("plugins.json");
    let mut file = PluginSettings::default();
    file.record_install(PLUGIN_ID, "0.1.0", &pin, bin.to_str().unwrap())
        .unwrap();
    file.set_enabled(PLUGIN_ID, enabled).unwrap();
    file.save(&settings).unwrap();
    Plugin { dir, settings }
}

#[test]
fn the_provider_is_the_connections_logical_name() {
    assert_eq!(provider_of("conn://demo/github").as_deref(), Some("github"));
    assert_eq!(
        provider_of("conn://org/proj/github@v3").as_deref(),
        Some("github")
    );
    assert_eq!(provider_of("cred://demo/github"), None);
    assert_eq!(provider_of("conn://github"), None);
}

#[test]
fn only_placeholder_deliveries_become_run_entries() {
    let mut handle = placeholder("HANDLE", "conn://demo/github");
    handle.delivery = CredentialDeliveryMode::Handle;
    let entries = vec![placeholder("GITHUB_TOKEN", "conn://demo/github"), handle];
    let spec = run_entries(&entries);
    assert_eq!(spec.len(), 1);
    assert_eq!(spec[0]["env_var"], "GITHUB_TOKEN");
    assert_eq!(spec[0]["provider_id"], "github");
    assert_eq!(spec[0]["site"], "authorization");
    // No scope declared: nothing is widened to the root on the entry's behalf.
    assert_eq!(spec[0]["path_prefixes"], json!([]));
}

#[test]
fn a_declared_scope_is_what_the_plugin_is_asked_to_issue() {
    let mut entry = placeholder("GITHUB_TOKEN", "conn://demo/github");
    entry.path_prefixes = vec!["/repos/acme".into(), "/user".into()];
    entry.projection.as_mut().unwrap().placement.methods = vec!["GET".into()];
    let spec = run_entries(&[entry]);
    assert_eq!(spec[0]["path_prefixes"], json!(["/repos/acme", "/user"]));
    assert_eq!(spec[0]["methods"], json!(["GET"]));
}

#[test]
fn an_entry_without_a_declared_scope_never_reaches_the_plugin_as_the_root() {
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    let spec = run_entries(&entries);
    assert!(
        !spec[0]["path_prefixes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "/"),
        "{spec:?}"
    );
}

#[test]
fn a_named_header_placement_becomes_a_header_site() {
    let mut entry = placeholder("KEY", "conn://demo/github");
    entry.projection.as_mut().unwrap().placement.locations = vec![PlaceholderLocation::Header {
        name: Some("X-Api-Key".into()),
    }];
    assert_eq!(run_entries(&[entry])[0]["site"], "header:x-api-key");
}

#[test]
fn with_nothing_installed_the_run_keeps_its_placeholders() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("plugins.json");
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    assert!(start(&entries, Some(&settings), &no_env, &NoStore)
        .unwrap()
        .is_none());
    assert!(start(&entries, None, &no_env, &NoStore).unwrap().is_none());
}

#[test]
fn installed_but_switched_off_the_run_keeps_its_placeholders() {
    let plugin = installed(FAKE_PLUGIN, false, None);
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    assert!(start(&entries, Some(&plugin.settings), &no_env, &NoStore)
        .unwrap()
        .is_none());
    assert!(!plugin.dir.path().join("spec.json").exists());
}

#[test]
fn a_force_off_in_the_environment_keeps_the_placeholders() {
    let plugin = installed(FAKE_PLUGIN, true, None);
    let off = |key: &str| (key == "OPENSESAME_PLUGIN_SURROGATE_PROXY").then(|| "off".to_owned());
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    assert!(start(&entries, Some(&plugin.settings), &off, &NoStore)
        .unwrap()
        .is_none());
}

#[test]
fn an_enabled_plugin_whose_bytes_changed_fails_the_run_closed() {
    let plugin = installed(FAKE_PLUGIN, true, Some(&"a".repeat(64)));
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    let error = start(&entries, Some(&plugin.settings), &no_env, &NoStore).unwrap_err();
    assert!(error.to_string().contains("pin"), "{error}");
    assert!(!plugin.dir.path().join("spec.json").exists());
}

#[cfg(unix)]
#[test]
fn an_active_plugin_replaces_placeholders_and_the_run_ends_with_the_session() {
    let plugin = installed(FAKE_PLUGIN, true, None);
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    let session = start(&entries, Some(&plugin.settings), &no_env, &NoStore)
        .unwrap()
        .expect("active plugin");
    assert!(session.env()["GITHUB_TOKEN"].starts_with("osr_"));
    assert_eq!(session.unserved(), ["OTHER".to_owned()]);
    let debug = format!("{session:?}");
    assert!(!debug.contains("osr_"), "{debug}");
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(plugin.dir.path().join("spec.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(spec["entries"][0]["env_var"], "GITHUB_TOKEN");
    assert!(spec["run_id"].as_str().unwrap().starts_with("dev-"));
    assert!(spec["notices_path"]
        .as_str()
        .unwrap()
        .ends_with("plugin-state/surrogate-proxy/notices.jsonl"));
    assert!(!plugin.dir.path().join("ended").exists());
    drop(session);
    assert!(plugin.dir.path().join("ended").exists());
}

#[cfg(unix)]
#[test]
fn when_no_entry_can_be_brokered_the_run_keeps_its_placeholders_and_the_plugin_ends() {
    let plugin = installed(
        &FAKE_PLUGIN.replace(r#""unserved":["OTHER"]"#, r#""unserved":["GITHUB_TOKEN"]"#),
        true,
        None,
    );
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    assert!(start(&entries, Some(&plugin.settings), &no_env, &NoStore)
        .unwrap()
        .is_none());
    assert!(plugin.dir.path().join("ended").exists());
}

#[cfg(unix)]
#[test]
fn a_plugin_that_refuses_the_run_fails_it() {
    let refusing = "#!/bin/sh\nread -r line\necho '{\"error\":\"plugin_not_active\"}'\n";
    let plugin = installed(refusing, true, None);
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    let error = start(&entries, Some(&plugin.settings), &no_env, &NoStore).unwrap_err();
    assert!(error.to_string().contains("plugin_not_active"), "{error}");
}

/// A stand-in plugin for a login run: records the spec (a test-only copy —
/// the real plugin never writes it anywhere) and answers with a surrogate.
const LOGIN_PLUGIN: &str = r#"#!/bin/sh
here="$(dirname "$0")"
IFS= read -r line
printf '%s\n' "$line" > "$here/spec.json"
printf '%s\n' '{"proxy_url":"http://u:p@127.0.0.1:9","ca_pem_path":"/run/ca.pem","env":{"APP_PASSWORD":"osr_11111111111111111111111111111111"},"unserved":[]}'
cat > /dev/null
: > "$here/ended"
"#;

fn login_entry() -> ResolvedEnvEntry {
    ResolvedEnvEntry {
        key: "APP_PASSWORD".into(),
        delivery: CredentialDeliveryMode::Placeholder,
        env_value: None,
        connection_ref: None,
        projection: None,
        omitted: true,
        warning: None,
        login: Some(web_login("https://app.example")),
        path_prefixes: Vec::new(),
    }
}

#[cfg(unix)]
#[test]
fn a_web_login_reaches_the_plugin_over_its_stdin_and_the_child_gets_a_surrogate() {
    let plugin = installed(LOGIN_PLUGIN, true, None);
    let store = FakeStore::with("Web/app", "url: https://app.example/login\n");
    let session = start(&[login_entry()], Some(&plugin.settings), &no_env, &store)
        .unwrap()
        .expect("a login run");
    let surrogate = &session.env()["APP_PASSWORD"];
    assert!(surrogate.starts_with("osr_"));
    assert!(session.env().values().all(|v| !v.contains("hunter2")));
    assert!(!format!("{session:?}").contains("hunter2"));
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(plugin.dir.path().join("spec.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(spec["logins"][0]["secret"], SECRET);
    assert_eq!(spec["logins"][0]["origin"], "https://app.example");
    assert_eq!(spec["logins"][0]["field"], "password");
    assert_eq!(spec["watched"], true);
    assert_eq!(*store.reads.borrow(), vec!["Web/app".to_owned()]);
    drop(session);
    assert!(plugin.dir.path().join("ended").exists());
}

#[test]
fn with_the_plugin_off_a_web_login_reads_no_password_and_delivers_nothing() {
    let plugin = installed(LOGIN_PLUGIN, false, None);
    let store = FakeStore::with("Web/app", "url: https://app.example\n");
    assert!(
        start(&[login_entry()], Some(&plugin.settings), &no_env, &store)
            .unwrap()
            .is_none()
    );
    assert!(store.reads.borrow().is_empty());
    assert!(!plugin.dir.path().join("spec.json").exists());
}

#[test]
fn a_login_the_store_does_not_bind_to_its_origin_never_starts_the_plugin() {
    let plugin = installed(LOGIN_PLUGIN, true, None);
    let store = FakeStore::with("Web/app", "url: https://elsewhere.example\n");
    let error = start(&[login_entry()], Some(&plugin.settings), &no_env, &store).unwrap_err();
    assert!(error.to_string().contains("refusing"), "{error}");
    assert!(!plugin.dir.path().join("spec.json").exists());
}

/// A stand-in for the plugin's rule: a served entry with no bounded path
/// scope is refused before anything is issued.
#[cfg(unix)]
const SCOPE_CHECKING_PLUGIN: &str = r#"#!/bin/sh
here="$(dirname "$0")"
IFS= read -r line
printf '%s\n' "$line" > "$here/spec.json"
case "$line" in
  *'"path_prefixes":[]'*|*'"path_prefixes":["/"]'*)
    printf '%s\n' '{"error":"spec_path_scope:GITHUB_TOKEN"}'
    : > "$here/refused"
    exit 2;;
esac
printf '%s\n' '{"proxy_url":"http://u:p@127.0.0.1:9","ca_pem_path":"/run/ca.pem","env":{"GITHUB_TOKEN":"osr_00000000000000000000000000000000"},"unserved":[]}'
cat > /dev/null
: > "$here/ended"
"#;

#[cfg(unix)]
#[test]
fn without_a_bounded_scope_the_run_is_refused_with_a_clear_error_and_nothing_is_issued() {
    let plugin = installed(SCOPE_CHECKING_PLUGIN, true, None);
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    let error = start(&entries, Some(&plugin.settings), &no_env, &NoStore).unwrap_err();
    let text = error.to_string();
    assert!(text.contains("GITHUB_TOKEN"), "{text}");
    assert!(text.contains("no bounded scope"), "{text}");
    assert!(text.contains("paths="), "{text}");
    assert!(text.contains("issued nothing"), "{text}");
    assert!(plugin.dir.path().join("refused").exists());
    // The CLI sent no root: it is the plugin that refused the unbounded entry.
    let spec = std::fs::read_to_string(plugin.dir.path().join("spec.json")).unwrap();
    assert!(spec.contains(r#""path_prefixes":[]"#), "{spec}");
    assert!(!spec.contains(r#""path_prefixes":["/"]"#), "{spec}");
}

#[cfg(unix)]
#[test]
fn with_a_declared_scope_the_same_run_is_issued_and_the_spec_carries_it() {
    let plugin = installed(SCOPE_CHECKING_PLUGIN, true, None);
    let mut entry = placeholder("GITHUB_TOKEN", "conn://demo/github");
    entry.path_prefixes = vec!["/repos/acme".into()];
    let session = start(&[entry], Some(&plugin.settings), &no_env, &NoStore)
        .unwrap()
        .expect("a bounded run");
    assert!(session.env()["GITHUB_TOKEN"].starts_with("osr_"));
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(plugin.dir.path().join("spec.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(spec["entries"][0]["path_prefixes"], json!(["/repos/acme"]));
    assert!(!plugin.dir.path().join("refused").exists());
}
