//! Unit tests for [`super`].

use serde_json::json;
use std::collections::BTreeMap;

fn plan() -> Vec<opensesame_connector_host::password_agent::env::BrokerEntry> {
    use opensesame_connector_host::password_agent::env as core;
    core::broker_plan(
        &[
            "GITHUB_TOKEN=os://vault/connections%2Facme%2Fgithub/password".into(),
            "VERCEL_TOKEN=os://vault/connections%2Facme%2Fapp%2Fvercel/credential".into(),
        ],
        &[
            "GITHUB_TOKEN=/repos/acme,/user".into(),
            "VERCEL_TOKEN=/v2/user".into(),
        ],
        &["GITHUB_TOKEN=GET".into(), "VERCEL_TOKEN=GET,POST".into()],
    )
    .unwrap()
}

#[test]
fn run_entries_carry_the_plan_at_the_authorization_site() {
    let entries = super::run_entries(&plan());
    assert_eq!(
        entries,
        [
            json!({
                "env_var": "GITHUB_TOKEN",
                "provider_id": "github",
                "connection_ref": "conn://acme/github",
                "site": "authorization",
                "methods": ["GET"],
                "path_prefixes": ["/repos/acme", "/user"],
            }),
            json!({
                "env_var": "VERCEL_TOKEN",
                "provider_id": "vercel",
                "connection_ref": "conn://acme/app/vercel",
                "site": "authorization",
                "methods": ["GET", "POST"],
                "path_prefixes": ["/v2/user"],
            }),
        ]
    );
}

#[test]
fn the_mask_list_covers_real_values_surrogates_and_the_proxy_credential() {
    let env: BTreeMap<String, String> = [
        ("GITHUB_TOKEN".into(), "osr_surrogate-canary".into()),
        (
            "HTTPS_PROXY".into(),
            "http://user:proxy-canary@127.0.0.1:9".into(),
        ),
    ]
    .into_iter()
    .collect();
    let masked = super::mask_list(&["real-canary".into()], &env);
    assert!(masked.contains(&"real-canary".to_string()));
    assert!(masked.contains(&"osr_surrogate-canary".to_string()));
    assert!(masked.contains(&"http://user:proxy-canary@127.0.0.1:9".to_string()));
}

#[cfg(unix)]
#[test]
fn a_supervised_child_holds_the_surrogate_and_never_prints_it() {
    let env: BTreeMap<String, String> = [("TOKEN".into(), "osr_child-canary".into())]
        .into_iter()
        .collect();
    let secrets = super::mask_list(&["real-canary".into()], &env);
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let end = super::spawn_supervised(
        &[
            "/bin/sh".into(),
            "-c".into(),
            "printf 'env=%s\\n' \"$TOKEN\"; printf 'err=%s\\n' real-canary >&2; exit 7".into(),
        ],
        &env,
        None,
        &secrets,
        &mut out,
        &mut err,
    )
    .expect("supervised child");
    assert_eq!(end.exit_code(), Some(7));
    assert_eq!(String::from_utf8(out).unwrap(), "env=[REDACTED]\n");
    assert_eq!(String::from_utf8(err).unwrap(), "err=[REDACTED]\n");
}
