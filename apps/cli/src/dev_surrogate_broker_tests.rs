//! Broker-mode tests for [`super`]: a `run --agent-proxy` session
//! fails closed wherever the `dev run` lane keeps placeholders.

use super::tests::{installed, no_env, FAKE_PLUGIN};
use super::*;
use serde_json::json;

fn brokered_github() -> Vec<Value> {
    vec![json!({
        "env_var": "GITHUB_TOKEN",
        "provider_id": "github",
        "connection_ref": "conn://demo/github",
        "site": "authorization",
        "methods": ["GET"],
        "path_prefixes": ["/repos/acme"],
    })]
}

#[test]
fn a_brokered_run_without_an_active_plugin_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("plugins.json");
    let error = start_brokered(&brokered_github(), &[], Some(&settings), &no_env).unwrap_err();
    assert!(error.to_string().contains("surrogate-proxy"), "{error}");
    assert!(start_brokered(&brokered_github(), &[], None, &no_env).is_err());
    let plugin = installed(FAKE_PLUGIN, false, None);
    assert!(start_brokered(&brokered_github(), &[], Some(&plugin.settings), &no_env).is_err());
    assert!(!plugin.dir.path().join("spec.json").exists());
}

#[cfg(unix)]
#[test]
fn a_brokered_run_the_plugin_serves_nothing_of_fails_and_ends_the_plugin() {
    let plugin = installed(
        &FAKE_PLUGIN.replace(r#""unserved":["OTHER"]"#, r#""unserved":["GITHUB_TOKEN"]"#),
        true,
        None,
    );
    let error =
        start_brokered(&brokered_github(), &[], Some(&plugin.settings), &no_env).unwrap_err();
    assert!(error.to_string().contains("GITHUB_TOKEN"), "{error}");
    assert!(plugin.dir.path().join("ended").exists());
}

#[cfg(unix)]
#[test]
fn an_active_plugin_brokers_the_run_and_carries_its_credential_over_the_pipe() {
    let plugin = installed(FAKE_PLUGIN, true, None);
    let entries = vec![json!({
        "env_var": "GITHUB_TOKEN",
        "provider_id": "vercel",
        "connection_ref": "conn://demo/vercel",
        "site": "authorization",
        "methods": ["GET"],
        "path_prefixes": ["/v2/user"],
    })];
    let credentials = [CredentialWire::new(
        "conn://demo/vercel".into(),
        Zeroizing::new("stored-token".into()),
    )];
    let session = start_brokered(&entries, &credentials, Some(&plugin.settings), &no_env)
        .expect("brokered run");
    assert!(session.env()["GITHUB_TOKEN"].starts_with("osr_"));
    assert!(session.run_id().starts_with("run-"));
    // OTHER is unserved but was never asked for: it does not fail the run.
    assert_eq!(session.unserved(), ["OTHER".to_owned()]);
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(plugin.dir.path().join("spec.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(spec["entries"][0]["provider_id"], "vercel");
    assert_eq!(
        spec["credentials"][0]["connection_ref"],
        "conn://demo/vercel"
    );
    assert_eq!(spec["credentials"][0]["secret"], "stored-token");
    drop(session);
    assert!(plugin.dir.path().join("ended").exists());
}
