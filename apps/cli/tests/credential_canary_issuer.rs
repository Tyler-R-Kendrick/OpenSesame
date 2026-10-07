//! Generated actual Host issuance, local owner terminal proof, independent configured authorization.
#![cfg(unix)]
#[path = "support/canary_terminal.rs"]
mod terminal;
use opensesame_domain::{ConnectionId, OrganizationId};
use opensesame_human_vault::{
    credential_canaries::{ArtifactKind, Phase, Registry},
    root_protection::{load_key_file, KeyFileContents},
};
use opensesame_storage::{
    credential_canaries::{ControlledReferenceDecision, HostCanaryBinding},
    Db,
};
use std::{
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct Host(Child);
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
async fn host(database: &str, operator: &str) -> (Host, String) {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = socket.local_addr().unwrap();
    drop(socket);
    let origin = format!("http://{address}");
    let mut child = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .env_clear()
        .env("OPENSESAME_ENV", "development")
        .env("OPENSESAME_ALLOW_DEV_DEFAULTS", "1")
        .env("OPENSESAME_OPERATOR_TOKEN", operator)
        .env(
            "OPENSESAME_CLAIM_PEPPER",
            "generated-fixture-pepper-0123456789abcdef0123456789abcdef",
        )
        .args([
            "host",
            "run",
            "--listen",
            &address.to_string(),
            "--resource",
            &origin,
            "--issuer",
            "http://127.0.0.1:8788",
            "--database-url",
            database,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if std::net::TcpStream::connect(address).is_ok() {
            break;
        }
        if child.try_wait().unwrap().is_some() {
            let result = child.wait_with_output().unwrap();
            panic!(
                "generated Host startup failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "generated Host did not start"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    (Host(child), origin)
}
async fn issue(
    db: &Db,
    identity: &str,
) -> (
    HostCanaryBinding,
    opensesame_storage::credential_canaries::IssuedControlledAlias,
) {
    let binding = HostCanaryBinding {
        organization_id: OrganizationId::from_uuid(uuid::Uuid::nil()),
        tomb: "personal".into(),
        vault_identity: identity.into(),
    };
    let target = ConnectionId::new();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query("INSERT INTO connections(id,organization_id,provider_id,logical_name,display_name,status,requested_scopes,granted_scopes,owner_kind,shareability,max_invoke_level,egress_json,created_at,updated_at) VALUES(?,?,?,?,'generated-target','active','[]','[]','human','private',1,'{}',?,?)")
        .bind(target.as_uuid().to_string()).bind(binding.organization_id.to_string()).bind("controlled-cli-fixture").bind("cli-target").bind(&now).bind(&now).execute(db.pool()).await.unwrap();
    let mut registry = Registry::new(&binding.tomb, identity);
    registry.create(ArtifactKind::ConnectionRef, &now).unwrap();
    db.register_controlled_canary(&binding, &registry.artifacts[0])
        .await
        .unwrap();
    let expires = (chrono::Utc::now() + chrono::Duration::minutes(10))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let alias = db
        .issue_controlled_alias(&binding.organization_id, &binding.tomb, &target, &expires)
        .await
        .unwrap();
    (binding, alias)
}
fn retire(
    root: &Path,
    origin: &str,
    id: &str,
    password: &str,
    operator: &str,
) -> std::process::Output {
    terminal::terminal_with_environment(
        root,
        &[
            "--server",
            origin,
            "pass",
            "security",
            "canary",
            "retire-issued",
            id,
            "--allow-loopback",
            "--path",
            root.to_str().unwrap(),
        ],
        &[password],
        false,
        &[("OPENSESAME_OPERATOR_TOKEN", operator)],
    )
}
#[tokio::test]
async fn actual_host_issuer_revokes_real_alias_and_imports_only_authentic_digest_after_two_owner_proofs(
) {
    let root = terminal::fixture();
    let KeyFileContents::Manifest(manifest) = load_key_file(root.path()).unwrap() else {
        panic!("expected genuine stable manifest")
    };
    let directory = tempfile::tempdir().unwrap();
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("host.db").display()
    );
    let db = Db::connect_sqlite(&database).await.unwrap();
    let (binding, alias) = issue(&db, &manifest.vault_id).await;
    let operator = "generated-owner-operator-0123456789abcdef0123456789abcdef";
    let (_host, origin) = host(&database, operator).await;
    for (password, credential) in [
        ("wrong owner", operator),
        (
            "generated owner",
            "generated-wrong-operator-0123456789abcdef0123456789abcdef",
        ),
    ] {
        let refused = retire(
            root.path(),
            &origin,
            &alias.issuer_record_ref,
            password,
            credential,
        );
        assert!(!refused.status.success());
        assert!(matches!(
            db.classify_controlled_reference(&binding.organization_id, &alias.reference)
                .await
                .unwrap(),
            ControlledReferenceDecision::ActiveAlias { .. }
        ));
    }
    let valid = retire(
        root.path(),
        &origin,
        &alias.issuer_record_ref,
        "generated owner",
        operator,
    );
    assert!(
        valid.status.success(),
        "{}",
        String::from_utf8_lossy(&valid.stderr)
    );
    assert_eq!(
        db.classify_controlled_reference(&binding.organization_id, &alias.reference)
            .await
            .unwrap(),
        ControlledReferenceDecision::Reject
    );
    let hosted = db
        .controlled_canary_status(&binding.organization_id, &binding.tomb)
        .await
        .unwrap();
    let local =
        opensesame_sealed_store::credential_canaries::status(root.path(), b"generated owner")
            .unwrap();
    assert!(local["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |artifact| artifact["id"] == alias.issuer_record_ref && artifact["state"] == "retired"
        ));
    assert!(!local.to_string().contains(&alias.reference));
    assert!(hosted
        .artifacts
        .iter()
        .any(|artifact| artifact.id == alias.issuer_record_ref));
    let raw = alias.reference.strip_prefix("osissued:v1:").unwrap();
    let observed = opensesame_sealed_store::credential_canaries::observe(
        root.path(),
        &alias.issuer_record_ref,
        raw,
        Phase::RetiredGenerationObserved,
    )
    .unwrap();
    assert!(observed.event.is_some());
    // The shared terminal helpers still execute a real hidden password ceremony and cold MCP refusal.
    assert!(
        terminal::human(root.path(), &["canary", "status"], &["generated owner"])
            .status
            .success()
    );
    assert!(String::from_utf8(
        terminal::serve(
            root.path(),
            &alias.issuer_record_ref,
            raw,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n"
        )
        .stdout
    )
    .unwrap()
    .contains("refused"));
}
