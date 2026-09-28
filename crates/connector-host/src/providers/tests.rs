//! Tests for the provider table and its parity with the fnox manifest.

use super::*;
use std::collections::HashSet;

#[test]
fn catalog_is_unique_and_covers_fnox_snapshot() {
    let providers = catalog();
    let ids: HashSet<_> = providers.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids.len(), providers.len());
    for required in [
        "age",
        "aws-secrets-manager",
        "azure-key-vault-secrets",
        "gcp-secret-manager",
        "1password",
        "bitwarden",
        "keepass",
        "openbao",
        "sealed-local",
        "aws-sts",
        "github-app",
        "custom-command",
    ] {
        assert!(ids.contains(required), "missing {required}");
    }
    assert!(providers
        .iter()
        .all(|p| p.support != ProviderSupport::Supported));

    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../../spec/connectors/fnox-parity.json")).unwrap();
    let required: HashSet<_> = manifest["providers"]
        .as_array()
        .unwrap()
        .iter()
        .chain(manifest["leases"].as_array().unwrap())
        .map(|id| id.as_str().unwrap())
        .collect();
    assert!(required.is_subset(&ids));
}

#[test]
fn human_commands_never_use_a_shell_or_split_the_resource() {
    let resource = "name; echo pwned $(touch nope)";
    let HumanProviderPlan::Command { executable, args } = human_plan(
        "aws-secrets-manager",
        HumanProviderOperation::Read,
        resource,
        &serde_json::json!({}),
    )
    .unwrap() else {
        panic!("expected command");
    };
    assert_eq!(executable, "aws");
    assert!(args.iter().any(|arg| arg == resource));
    assert!(!args.iter().any(|arg| arg == "sh" || arg == "-c"));
}

#[test]
fn bitwarden_without_native_config_still_shells_to_the_bw_cli() {
    for provider in ["bitwarden", "vaultwarden"] {
        let plan = human_plan(
            provider,
            HumanProviderOperation::Read,
            "GitHub",
            &serde_json::json!({ "server_url": "https://vault.example.com" }),
        )
        .unwrap();
        assert_eq!(
            plan,
            HumanProviderPlan::Command {
                executable: "bw".into(),
                args: vec![
                    "get".into(),
                    "password".into(),
                    "GitHub".into(),
                    "--raw".into()
                ],
            },
            "{provider} must keep the legacy plan when native_client is absent"
        );
        let plan = human_plan(
            provider,
            HumanProviderOperation::List,
            "all",
            &serde_json::json!({}),
        )
        .unwrap();
        assert_eq!(
            plan,
            HumanProviderPlan::Command {
                executable: "bw".into(),
                args: vec!["list".into(), "items".into(), "--raw".into()],
            }
        );
    }
}

#[test]
fn bitwarden_with_native_config_plans_the_native_client() {
    for provider in ["bitwarden", "vaultwarden"] {
        for enabled in [
            serde_json::json!(true),
            serde_json::json!("true"),
            serde_json::json!("TRUE"),
            serde_json::json!("1"),
        ] {
            let plan = human_plan(
                provider,
                HumanProviderOperation::Read,
                "Work/GitHub",
                &serde_json::json!({
                    "native_client": enabled,
                    "server_url": "https://vault.example.com",
                }),
            )
            .unwrap();
            assert_eq!(
                plan,
                HumanProviderPlan::Bitwarden {
                    server_url: "https://vault.example.com".into(),
                    resource: "Work/GitHub".into(),
                    operation: HumanProviderOperation::Read,
                },
                "{provider} with native_client={enabled}"
            );
        }
        let plan = human_plan(
            provider,
            HumanProviderOperation::List,
            "all",
            &serde_json::json!({
                "native_client": true,
                "server_url": "https://vault.example.com",
            }),
        )
        .unwrap();
        assert_eq!(
            plan,
            HumanProviderPlan::Bitwarden {
                server_url: "https://vault.example.com".into(),
                resource: "all".into(),
                operation: HumanProviderOperation::List,
            }
        );
    }
}

#[test]
fn a_native_bitwarden_connection_must_name_its_server() {
    let error = human_plan(
        "bitwarden",
        HumanProviderOperation::Read,
        "GitHub",
        &serde_json::json!({ "native_client": true }),
    )
    .unwrap_err();
    assert_eq!(
        error,
        ProviderExecutionError::MissingConfig("server_url".into())
    );
}

#[test]
fn a_falsey_native_client_flag_keeps_the_cli_path() {
    for flag in [
        serde_json::json!(false),
        serde_json::json!("false"),
        serde_json::json!("no"),
        serde_json::json!(0),
        serde_json::json!(null),
    ] {
        let plan = human_plan(
            "bitwarden",
            HumanProviderOperation::Read,
            "GitHub",
            &serde_json::json!({ "native_client": flag, "server_url": "https://x.example" }),
        )
        .unwrap();
        assert!(
            matches!(plan, HumanProviderPlan::Command { ref executable, .. } if executable == "bw"),
            "native_client={flag} must not opt in"
        );
    }
}

#[test]
fn native_bitwarden_plans_carry_no_credential_material() {
    let plan = human_plan(
        "vaultwarden",
        HumanProviderOperation::Read,
        "GitHub",
        &serde_json::json!({
            "native_client": true,
            "server_url": "https://vault.example.com",
            "session_token": "BW_SESSION-should-never-be-copied",
        }),
    )
    .unwrap();
    let rendered = format!("{plan:?}");
    assert!(
        !rendered.contains("BW_SESSION-should-never-be-copied"),
        "a plan must never carry a secret: {rendered}"
    );
}

#[test]
fn the_sync_executor_refuses_the_native_bitwarden_plan() {
    // Same contract as GitHubApp: the sync executor — the one agent and
    // MCP surfaces can reach — refuses, and only the async CLI call site
    // performs the read.
    let error = execute_human_plan(HumanProviderPlan::Bitwarden {
        server_url: "https://vault.example.com".into(),
        resource: "GitHub".into(),
        operation: HumanProviderOperation::Read,
    })
    .unwrap_err();
    assert!(matches!(error, ProviderExecutionError::Unavailable(ref m) if m.contains("CLI")));
    let github = execute_human_plan(HumanProviderPlan::GitHubApp {
        app_id: None,
        installation_id: None,
        private_key_path: None,
    })
    .unwrap_err();
    assert!(matches!(github, ProviderExecutionError::Unavailable(_)));
}

#[test]
fn crypto_uses_file_arguments_not_plaintext() {
    let plan = crypto_plan(
        "gcp-kms",
        CryptoOperation::Encrypt,
        Path::new("input with spaces.txt"),
        Path::new("output.enc"),
        &serde_json::json!({
            "key": "app",
            "keyring": "prod",
            "location": "global",
            "project": "acme"
        }),
    )
    .unwrap();
    assert_eq!(plan.executable, "gcloud");
    assert!(plan.args.iter().any(|arg| arg == "input with spaces.txt"));
    assert!(!plan.args.iter().any(|arg| arg == "sh" || arg == "-c"));
}

/// The agent-facing sealed-store provider must never surface an
/// attachment — not in a listing, not through a read.
///
/// Nothing in this file enforces that directly. It holds because
/// `StoreRoot::ls` filters to an extension allowlist that omits
/// `.osattach`, and because `show` resolves `<name>.osseal`. Both are
/// decisions made in another crate, either of which could be relaxed by
/// someone with no idea this boundary depends on them. Documents in a
/// vault are exactly what ADR 0005 says an agent must not reach, so the
/// property is pinned here where the agent surface lives.
#[test]
fn attachments_are_invisible_to_the_agent_facing_provider() {
    use opensesame_sealed_store::{AttachMeta, Entry, ItemDataKey};

    let dir = tempfile::tempdir().expect("tempdir");
    let store = opensesame_sealed_store::init_store(dir.path(), &[]).expect("init");
    let key = ItemDataKey([5u8; 32]);

    store
        .insert("Dev/token", &Entry::parse("hunter2"), &key)
        .expect("entry");
    let payload = b"a scan of a passport".to_vec();
    let mut source = std::io::Cursor::new(payload.clone());
    store
        .attach_add(
            "Taxes/passport",
            &mut source,
            payload.len() as u64,
            AttachMeta {
                filename: "passport.pdf".into(),
                mime: None,
            },
            &key,
            false,
        )
        .expect("attach");

    // List: the entry is visible, the attachment is not — and neither is
    // the object pool that holds its ciphertext.
    let listed = execute_sealed_store(HumanProviderOperation::List, dir.path(), "").expect("list");
    assert!(
        listed.contains("Dev/token"),
        "entries stay listable: {listed}"
    );
    assert!(
        !listed.contains("Taxes/passport"),
        "an attachment must not appear in the agent-facing listing: {listed}"
    );
    assert!(
        !listed.contains("oschunk")
            && !listed.contains("osattach")
            && !listed.contains("attachments"),
        "no attachment artefact may leak into the listing: {listed}"
    );

    // Read: naming the attachment directly must not return it. There is no
    // password set here, so this stops at the unlock — assert on the
    // outcome, not the reason, since either refusal is acceptable.
    assert!(
        execute_sealed_store(HumanProviderOperation::Read, dir.path(), "Taxes/passport").is_err(),
        "an attachment must not be readable through the agent surface"
    );

    // And the plaintext never appears in whatever the provider does return.
    let leaked = String::from_utf8_lossy(&payload).to_string();
    assert!(!listed.contains(&leaked), "plaintext must never surface");
}

#[test]
fn password_store_plan_does_not_shell_to_pass() {
    let plan = human_plan(
        "password-store",
        HumanProviderOperation::List,
        "/",
        &serde_json::json!({"store_dir": "/tmp/store"}),
    )
    .unwrap();
    match plan {
        HumanProviderPlan::Command { executable, .. } => {
            panic!("expected SealedStore, got command {executable}")
        }
        HumanProviderPlan::SealedStore { store_dir, .. } => {
            assert_eq!(store_dir, PathBuf::from("/tmp/store"));
        }
        other => panic!("unexpected plan {other:?}"),
    }
}

#[test]
fn github_app_plan_is_native_and_never_carries_key_material() {
    let plan = human_plan(
        "github-app",
        HumanProviderOperation::Lease,
        "12345678",
        &serde_json::json!({
            "app_id": "424242",
            "private_key_path": "/keys/app.pem"
        }),
    )
    .unwrap();
    match &plan {
        HumanProviderPlan::GitHubApp {
            app_id,
            installation_id,
            private_key_path,
        } => {
            assert_eq!(app_id.as_deref(), Some("424242"));
            assert_eq!(installation_id.as_deref(), Some("12345678"));
            // The plan names a file; the PEM itself must never enter a plan.
            assert_eq!(private_key_path.as_deref(), Some("/keys/app.pem"));
        }
        other => panic!("unexpected plan {other:?}"),
    }
    // connector-host itself refuses to execute it — the CLI owns the mint,
    // so no agent/MCP surface can reach a token through this crate.
    assert!(matches!(
        execute_human_plan(plan),
        Err(ProviderExecutionError::Unavailable(_))
    ));
}

#[test]
fn github_app_auto_resource_defers_installation_resolution() {
    let plan = human_plan(
        "github-app",
        HumanProviderOperation::Lease,
        "auto",
        &serde_json::json!({}),
    )
    .unwrap();
    match plan {
        HumanProviderPlan::GitHubApp {
            installation_id, ..
        } => assert!(installation_id.is_none()),
        other => panic!("unexpected plan {other:?}"),
    }
}

#[test]
fn native_live_probe_never_returns_material() {
    let probe = probe_live(&find("sealed-local").unwrap());
    assert!(probe.available && probe.live);
    assert!(!probe.detail.to_ascii_lowercase().contains("secret"));
}
