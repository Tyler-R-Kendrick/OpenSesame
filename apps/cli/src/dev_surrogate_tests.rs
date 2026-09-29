use super::*;
use opensesame_domain::{LegacyProjection, PlaceholderPlacement};
use opensesame_plugin_settings::sha256_file;

fn placeholder(key: &str, uri: &str) -> ResolvedEnvEntry {
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
    }
}

fn no_env(_: &str) -> Option<String> {
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

struct Plugin {
    dir: tempfile::TempDir,
    settings: std::path::PathBuf,
}

fn installed(script: &str, enabled: bool, pin: Option<&str>) -> Plugin {
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
    assert_eq!(spec[0]["path_prefixes"], json!(["/"]));
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
    assert!(start(&entries, Some(&settings), &no_env).unwrap().is_none());
    assert!(start(&entries, None, &no_env).unwrap().is_none());
}

#[test]
fn installed_but_switched_off_the_run_keeps_its_placeholders() {
    let plugin = installed(FAKE_PLUGIN, false, None);
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    assert!(start(&entries, Some(&plugin.settings), &no_env)
        .unwrap()
        .is_none());
    assert!(!plugin.dir.path().join("spec.json").exists());
}

#[test]
fn a_force_off_in_the_environment_keeps_the_placeholders() {
    let plugin = installed(FAKE_PLUGIN, true, None);
    let off = |key: &str| (key == "OPENSESAME_PLUGIN_SURROGATE_PROXY").then(|| "off".to_owned());
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    assert!(start(&entries, Some(&plugin.settings), &off)
        .unwrap()
        .is_none());
}

#[test]
fn an_enabled_plugin_whose_bytes_changed_fails_the_run_closed() {
    let plugin = installed(FAKE_PLUGIN, true, Some(&"a".repeat(64)));
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    let error = start(&entries, Some(&plugin.settings), &no_env).unwrap_err();
    assert!(error.to_string().contains("pin"), "{error}");
    assert!(!plugin.dir.path().join("spec.json").exists());
}

#[cfg(unix)]
#[test]
fn an_active_plugin_replaces_placeholders_and_the_run_ends_with_the_session() {
    let plugin = installed(FAKE_PLUGIN, true, None);
    let entries = [placeholder("GITHUB_TOKEN", "conn://demo/github")];
    let session = start(&entries, Some(&plugin.settings), &no_env)
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
    assert!(start(&entries, Some(&plugin.settings), &no_env)
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
    let error = start(&entries, Some(&plugin.settings), &no_env).unwrap_err();
    assert!(error.to_string().contains("plugin_not_active"), "{error}");
}
