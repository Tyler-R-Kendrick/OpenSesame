//! A provider CLI is the trusted file, hears nothing of the Host's own
//! secrets, and is handed what it reads and no more.

use super::*;
use crate::providers::{
    catalog, crypto_plan, execute_crypto_plan_in, execute_human_plan_in, human_plan, probe_live_in,
    probe_local_in, CryptoOperation, HumanProviderOperation, HumanProviderPlan,
    ProviderExecutionError,
};
use opensesame_trusted_exec::testkit::{Fixture, HOSTILE, SECRET};
use std::collections::BTreeMap;

/// The parent variables that are the Host's, not a provider's.
const HOSTS_OWN: [&str; 3] = [
    "OPENSESAME_CONNECTION_KEY",
    "OPENSESAME_STORE_PASSWORD",
    "GITHUB_APP_PRIVATE_KEY",
];

/// One variable of each family a CLI reads, set in the parent together.
const FAMILIES: [(&str, &str); 12] = [
    ("aws", "AWS_PROFILE"),
    ("az", "AZURE_CONFIG_DIR"),
    ("bao", "BAO_ADDR"),
    ("bw", "BW_SESSION"),
    ("bws", "BWS_ACCESS_TOKEN"),
    ("doppler", "DOPPLER_TOKEN"),
    ("gh", "GH_HOST"),
    ("gcloud", "CLOUDSDK_CONFIG"),
    ("infisical", "INFISICAL_TOKEN"),
    ("op", "OP_SERVICE_ACCOUNT_TOKEN"),
    ("pass", "PASSWORD_STORE_DIR"),
    ("vault", "VAULT_ADDR"),
];

fn run_stub(name: &str, extra: &[(&str, &str)]) -> (Fixture, BTreeMap<String, String>) {
    let fixture = Fixture::new(name);
    let lookup = fixture.lookup(extra);
    let output = output(name, &["--version"], &lookup).expect("the trusted stub runs");
    assert!(output.status.success());
    assert!(!fixture.planted_ran(), "the planted {name} ran");
    let env = fixture.env().expect("the trusted stub recorded");
    (fixture, env)
}

#[test]
fn every_provider_cli_is_the_trusted_one_and_hears_nothing_of_the_hosts_secrets() {
    for cli in &CLIS {
        let (_fixture, env) = run_stub(cli.name, &[]);
        for name in HOSTS_OWN {
            assert!(!env.contains_key(name), "{name} reached {}", cli.name);
        }
        for (name, _) in HOSTILE {
            if name.starts_with("GIT_") || name.starts_with("OPENSESAME_") {
                assert!(!env.contains_key(name), "{name} reached {}", cli.name);
            }
        }
        // The CLI's own credentials are the connection's, passed on purpose.
        assert_eq!(
            env.contains_key("AWS_SECRET_ACCESS_KEY"),
            cli.name == "aws",
            "{}: {env:?}",
            cli.name
        );
        assert!(!env.keys().any(|name| name.starts_with("OPENSESAME_")));
    }
}

#[test]
fn each_cli_is_handed_its_own_family_and_no_other() {
    let extra: Vec<(&str, &str)> = FAMILIES.iter().map(|(_, name)| (*name, SECRET)).collect();
    for (cli, own) in FAMILIES {
        let (_fixture, env) = run_stub(cli, &extra);
        assert!(env.contains_key(own), "{cli} lacks {own}");
        for (other_cli, other) in FAMILIES {
            // OpenBao reads the Vault family too.
            let shared = cli == "bao" && other_cli == "vault";
            if other_cli != cli && !shared {
                assert!(!env.contains_key(other), "{other} reached {cli}");
            }
        }
    }
}

#[test]
fn a_cli_that_reaches_the_network_hears_the_operators_proxy_and_one_that_does_not_does_not() {
    let extra = [("HTTPS_PROXY", "http://proxy.example:3128")];
    let (_vault, env) = run_stub("vault", &extra);
    assert_eq!(
        env.get("HTTPS_PROXY").map(String::as_str),
        Some("http://proxy.example:3128")
    );
    let (_age, env) = run_stub("age", &extra);
    assert!(!env.contains_key("HTTPS_PROXY"));
}

#[test]
fn the_variable_for_a_cli_names_the_exact_file_and_is_not_handed_on() {
    let fixture = Fixture::new("vault");
    let chosen = fixture.scratch("chosen").join("vault");
    fixture.stub_recorder(&chosen);
    let lookup = fixture.lookup(&[("OPENSESAME_VAULT_BIN", chosen.to_str().unwrap())]);
    output("vault", &["status"], &lookup).expect("the named file runs");
    let env = fixture.assert_clean();
    assert!(!env.contains_key("OPENSESAME_VAULT_BIN"));
    assert_eq!(fixture.args().unwrap(), ["status"]);
}

#[test]
fn a_variable_that_cannot_be_used_is_an_error_naming_it_and_never_a_search() {
    let fixture = Fixture::new("aws");
    let lookup = fixture.lookup(&[("OPENSESAME_AWS_BIN", "aws")]);
    let error = output("aws", &["--version"], &lookup).unwrap_err();
    assert!(error.contains("OPENSESAME_AWS_BIN"), "{error}");
    assert!(!fixture.planted_ran() && fixture.env().is_none());
}

#[test]
fn not_finding_a_cli_says_which_variable_points_at_it() {
    let fixture = Fixture::new("gcloud");
    std::fs::remove_file(fixture.trusted.join("gcloud")).unwrap();
    let error = output("gcloud", &["version"], &fixture.lookup(&[])).unwrap_err();
    assert!(error.contains("OPENSESAME_GCLOUD_BIN"), "{error}");
    assert!(!fixture.planted_ran());
}

#[test]
fn a_name_off_the_table_is_never_started() {
    let fixture = Fixture::new("rm");
    let error = output("rm", &["-rf", "/"], &fixture.lookup(&[])).unwrap_err();
    assert!(error.contains("not a provider CLI"), "{error}");
    assert!(!fixture.planted_ran() && fixture.env().is_none());
}

#[test]
fn the_catalog_and_every_plan_name_only_cli_on_the_table() {
    let mut off_the_table = std::collections::BTreeSet::new();
    let mut check = |provider: &str, name: &str| {
        if !is_provider_cli(name) {
            off_the_table.insert(format!("{provider}: {name}"));
        }
    };
    for provider in catalog() {
        if let Some(name) = provider.adapter.strip_prefix("cli:") {
            check(&provider.id, name);
        }
    }
    let config = serde_json::json!({
        "config": "c", "database": "d", "field": "f", "identity": "i", "key": "k",
        "keyring": "r", "location": "l", "project": "p", "recipient": "r",
        "server_url": "https://s.example", "store": "s", "vault": "v",
        "executable": "custom-tool",
    });
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in");
    std::fs::write(&input, b"x").unwrap();
    for provider in catalog() {
        for operation in [
            HumanProviderOperation::Read,
            HumanProviderOperation::List,
            HumanProviderOperation::Lease,
            HumanProviderOperation::Revoke,
        ] {
            if let Ok(HumanProviderPlan::Command { executable, .. }) =
                human_plan(&provider.id, operation, "resource", &config)
            {
                check(&provider.id, &executable);
            }
        }
        for operation in [CryptoOperation::Encrypt, CryptoOperation::Decrypt] {
            let output = dir.path().join("out");
            if let Ok(plan) = crypto_plan(&provider.id, operation, &input, &output, &config) {
                check(&provider.id, &plan.executable);
            }
        }
    }
    assert!(
        off_the_table.is_empty(),
        "not on the table: {off_the_table:?}"
    );
}

#[test]
fn a_connections_own_command_is_not_a_provider_cli_and_runs_as_written() {
    let config = serde_json::json!({"executable": "/bin/echo", "args": ["{resource}"]});
    let plan = human_plan(
        "custom-command",
        HumanProviderOperation::Lease,
        "hello",
        &config,
    )
    .unwrap();
    assert!(matches!(plan, HumanProviderPlan::Custom { .. }), "{plan:?}");
    assert_eq!(
        execute_human_plan_in(plan, &Lookup::capture()).unwrap(),
        "hello"
    );
}

#[test]
fn the_probes_and_plans_run_the_trusted_cli_and_never_the_planted_one() {
    let fixture = Fixture::new("vault");
    let lookup = fixture.lookup(&[]);
    let provider = catalog().into_iter().find(|p| p.id == "vault").unwrap();
    let local = probe_local_in(&provider, &lookup);
    assert!(local.available, "{local:?}");
    let live = probe_live_in(&provider, &lookup);
    assert!(live.live, "{live:?}");
    let plan = human_plan(
        "vault",
        HumanProviderOperation::List,
        "secret/",
        &serde_json::json!({}),
    )
    .unwrap();
    execute_human_plan_in(plan, &lookup).expect("the trusted vault lists");
    let _ = fixture.assert_clean();
}

#[test]
fn a_crypto_plan_runs_the_trusted_cli_and_a_missing_one_is_unavailable_by_name() {
    let fixture = Fixture::new("age");
    let dir = fixture.scratch("io");
    let (input, output_path) = (dir.join("in"), dir.join("out"));
    std::fs::write(&input, b"x").unwrap();
    let plan = crypto_plan(
        "age",
        CryptoOperation::Encrypt,
        &input,
        &output_path,
        &serde_json::json!({"recipient": "age1dummy"}),
    )
    .unwrap();
    // The stub exits 0 without writing the file, so the plan is refused only
    // for that, after the trusted age ran and the planted one did not.
    let error = execute_crypto_plan_in(plan.clone(), &fixture.lookup(&[])).unwrap_err();
    assert!(
        matches!(error, ProviderExecutionError::WriteFailed(_)),
        "{error:?}"
    );
    let _ = fixture.assert_clean();
    std::fs::remove_file(fixture.trusted.join("age")).unwrap();
    let error = execute_crypto_plan_in(plan, &fixture.lookup(&[])).unwrap_err();
    assert!(error.to_string().contains("OPENSESAME_AGE_BIN"), "{error}");
}
