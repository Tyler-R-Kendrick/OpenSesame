//! Rewired local-only CLI verbs (no Host / Identity / daemon).

use std::process::Command;

fn opensesame_in(store: &tempfile::TempDir) -> Command {
    let home = store.path();
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env("XDG_CONFIG_HOME", home)
        .env("HOME", home)
        .env("OPENSESAME_STORE_DIR", home.join("pass"))
        .env("OPENSESAME_STORE_PASSWORD", "test-passphrase-123");
    command
}

#[test]
fn doctor_reports_local_profile_without_network() {
    let store = tempfile::tempdir().unwrap();
    let output = opensesame_in(&store)
        .args(["doctor", "--output", "json"])
        .output()
        .expect("doctor runs");
    assert!(output.status.success(), "{:?}", output.stderr);
    let body: serde_json::Value = serde_json::from_slice(&output.stdout).expect("doctor json");
    assert_eq!(body["profile"], "local");
    assert!(body.get("sealed_store").is_some());
}

#[test]
fn config_ls_starts_empty_then_lists_slug() {
    let store = tempfile::tempdir().unwrap();
    let ls = opensesame_in(&store)
        .args(["config", "ls", "--output", "json"])
        .output()
        .unwrap();
    assert!(ls.status.success());
    let empty: serde_json::Value = serde_json::from_slice(&ls.stdout).unwrap();
    assert!(empty["configs"].as_array().unwrap().is_empty());

    let dotenv = store.path().join("env.txt");
    std::fs::write(&dotenv, "API_TOKEN=abc123\n").unwrap();
    let import = opensesame_in(&store)
        .args([
            "config",
            "import",
            dotenv.to_str().unwrap(),
            "--config",
            "dev",
        ])
        .output()
        .unwrap();
    assert!(import.status.success(), "{:?}", import.stderr);

    let ls2 = opensesame_in(&store)
        .args(["config", "ls", "--output", "json"])
        .output()
        .unwrap();
    let listed: serde_json::Value = serde_json::from_slice(&ls2.stdout).unwrap();
    assert!(listed["configs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == "dev"));
}

#[test]
fn vault_secret_list_on_fresh_store_is_empty() {
    let store = tempfile::tempdir().unwrap();
    let path = store.path().join("vault");
    let init_out = opensesame_in(&store)
        .args(["vault", "pass", "init", "--path", path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(init_out.status.success(), "{:?}", init_out.stderr);

    let list = opensesame_in(&store)
        .args(["vault", "secret", "list", "--path", path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(list.status.success(), "{:?}", list.stderr);
}
