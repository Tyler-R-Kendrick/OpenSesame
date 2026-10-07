//! Actual Unix terminal management and cold stdio detector processes, with generated fixtures.
#![cfg(unix)]
use opensesame_human_vault::credential_canaries::{ArtifactKind, CreatedArtifact};
#[path = "support/canary_terminal.rs"]
mod terminal;
use std::{
    io::Write,
    process::{Command, Stdio},
};
use terminal::{fixture, human, serve, terminal};
#[test]
fn genuine_terminal_owner_crud_and_cold_mcp_process_keep_real_root_unreachable() {
    let dir = fixture();
    let original = std::fs::read(dir.path().join(".opensesame-key")).unwrap();
    let rejected = human(
        dir.path(),
        &["canaries", "create", "--kind", "mcp-configuration"],
        &["wrong generated owner"],
    );
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
    let created = human(
        dir.path(),
        &["canaries", "create", "--kind", "mcp-configuration"],
        &["generated owner"],
    );
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    assert!(!String::from_utf8_lossy(&created.stdout).contains("generated owner"));
    assert!(!String::from_utf8_lossy(&created.stderr).contains("generated owner"));
    let value: serde_json::Value = serde_json::from_slice(&created.stdout).unwrap();
    let artifact: CreatedArtifact = serde_json::from_value(value["artifact"].clone()).unwrap();
    assert!(value["configuration"]["mcpServers"]["OpenSesameCanary"].is_object());
    let mut request = String::from("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n");
    for id in 2..10 {
        request.push_str(&format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/call\",\"params\":{{\"name\":\"canary.status\",\"arguments\":{{}}}}}}\n"
        ));
    }
    let observed = serve(dir.path(), &artifact.id, &artifact.presented_id, &request);
    assert!(observed.status.success());
    let wire = String::from_utf8(observed.stdout).unwrap();
    assert_eq!(
        wire.matches("synthetic").count(),
        8,
        "unexpected controlled response: {}",
        wire.replace(&artifact.presented_id, "[redacted]")
            .replace("generated owner", "[redacted]")
    );
    assert!(!wire.contains("generated owner"));
    assert!(!wire.contains(&artifact.presented_id));
    let status = human(dir.path(), &["canaries", "status"], &["generated owner"]);
    assert!(status.status.success());
    let status: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["events"].as_array().unwrap().len(), 2);
    assert!(!status.to_string().contains(&artifact.presented_id));
    assert!(opensesame_sealed_store::unlock_store_key(
        dir.path(),
        artifact.presented_id.as_bytes()
    )
    .is_err());
    assert_eq!(
        std::fs::read(dir.path().join(".opensesame-key")).unwrap(),
        original
    );
    let cleared = human(
        dir.path(),
        &["canaries", "clear-events"],
        &["generated owner"],
    );
    assert!(cleared.status.success());
    let removed = human(
        dir.path(),
        &["canaries", "remove", &artifact.id],
        &["generated owner"],
    );
    assert!(removed.status.success());
    let stale = serve(dir.path(), &artifact.id, &artifact.presented_id, &request);
    assert!(String::from_utf8(stale.stdout).unwrap().contains("refused"));
    assert_eq!(
        std::fs::read(dir.path().join(".opensesame-key")).unwrap(),
        original
    );
}
#[test]
fn non_terminal_automation_cannot_manage_bait_or_receivers() {
    for args in [["canaries", "status"], ["receiver", "status"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_opensesame"))
            .args(["pass", "security"])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("human terminal"));
    }
}
#[test]
fn registered_connection_reference_cannot_be_used_as_an_mcp_validator() {
    let dir = fixture();
    let artifact = opensesame_sealed_store::credential_canaries::create(
        dir.path(),
        b"generated owner",
        ArtifactKind::ConnectionRef,
    )
    .unwrap();
    let output = serve(
        dir.path(),
        &artifact.id,
        &artifact.presented_id,
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n",
    );
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("refused"));
}
fn install_detector(
    owner: &std::path::Path,
    directory: &std::path::Path,
    artifact: &CreatedArtifact,
) -> opensesame_human_vault::credential_canaries::ValidatorBinding {
    use std::os::unix::fs::PermissionsExt;
    let input = directory.join("binding.json");
    let exported = human(
        owner,
        &[
            "canary",
            "export-validator",
            &artifact.id,
            "--output-file",
            input.to_str().unwrap(),
        ],
        &["generated owner", &artifact.presented_id],
    );
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    let raw = std::fs::read_to_string(&input).unwrap();
    assert!(!raw.contains(&artifact.presented_id));
    assert!(!raw.contains("generated owner"));
    assert_eq!(
        std::fs::metadata(&input).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let binding =
        opensesame_human_vault::credential_canaries::ValidatorBinding::parse(&raw).unwrap();
    let installed = terminal(
        owner,
        &[
            "canary",
            "install",
            "--directory",
            directory.to_str().unwrap(),
            "--binding-file",
            input.to_str().unwrap(),
            "--approve-vault-identity",
            &binding.context.vault_identity,
        ],
        &[],
        false,
    );
    assert!(
        installed.status.success(),
        "{}",
        String::from_utf8_lossy(&installed.stderr)
    );
    binding
}
#[test]
fn standalone_installed_detector_cold_process_never_opens_a_production_key_and_uninstall_revokes_it(
) {
    let owner = fixture();
    let artifact = opensesame_sealed_store::credential_canaries::create(
        owner.path(),
        b"generated owner",
        ArtifactKind::McpConfiguration,
    )
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    // The detector deliberately rejects group/world-accessible directories.
    // Give this owner-created fixture explicit permissions, independent of umask.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let binding = install_detector(owner.path(), directory.path(), &artifact);
    assert!(!directory.path().join(".opensesame-key").exists());
    let mut child = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["canary", "serve", "--directory"])
        .arg(directory.path())
        .args(["--validator-id", &binding.validator_id])
        .env("OPENSESAME_CANARY_TOKEN", &artifact.presented_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"canary.status\",\"arguments\":{}}}\n").unwrap();
    let response = child.wait_with_output().unwrap();
    assert!(response.status.success());
    assert!(String::from_utf8(response.stdout)
        .unwrap()
        .contains("synthetic"));
    let status = terminal(
        owner.path(),
        &[
            "canary",
            "status",
            "--directory",
            directory.path().to_str().unwrap(),
            "--validator-id",
            &binding.validator_id,
        ],
        &[],
        false,
    );
    assert!(status.status.success());
    assert!(!String::from_utf8(status.stdout)
        .unwrap()
        .contains(&artifact.presented_id));
    let removed = terminal(
        owner.path(),
        &[
            "canary",
            "uninstall",
            "--directory",
            directory.path().to_str().unwrap(),
            "--validator-id",
            &binding.validator_id,
        ],
        &[],
        false,
    );
    assert!(removed.status.success());
    assert!(
        opensesame_sealed_store::credential_canaries::validator::handle(
            directory.path(),
            &binding.validator_id,
            &artifact.presented_id,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
        )
        .is_err()
    );
    assert!(!directory.path().join(".opensesame-key").exists());
}
#[test]
fn cold_stdio_bounds_messages_and_rejects_production_tool_names_without_echoing_input() {
    let root = fixture();
    let artifact = opensesame_sealed_store::credential_canaries::create(
        root.path(),
        b"generated owner",
        ArtifactKind::McpConfiguration,
    )
    .unwrap();
    let hostile=format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{{\"name\":\"vault.export\",\"arguments\":{{\"password\":\"{}\"}}}}}}\n",artifact.presented_id);
    let rejected = serve(root.path(), &artifact.id, &artifact.presented_id, &hostile);
    let wire = String::from_utf8(rejected.stdout).unwrap();
    assert!(wire.contains("refused"));
    assert!(!wire.contains(&artifact.presented_id));
    assert!(!wire.contains("vault.export"));
    let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n".repeat(65);
    let bounded = serve(root.path(), &artifact.id, &artifact.presented_id, &input);
    assert!(bounded.status.success());
    assert_eq!(
        String::from_utf8(bounded.stdout).unwrap().lines().count(),
        64
    );
    let oversized = format!("{}\n", "a".repeat(4097));
    let rejected = serve(
        root.path(),
        &artifact.id,
        &artifact.presented_id,
        &oversized,
    );
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
}
