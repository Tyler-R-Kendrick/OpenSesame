use super::{conpty::Result as TerminalResult, journey::Journey};
use opensesame_human_vault::{credential_canaries::CreatedArtifact, windows_io};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
const REQUEST:&str="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"canary.status\",\"arguments\":{}}}\n";
fn cold(args: &[&str], token: &str) -> Zeroizing<String> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(args)
        .env("OPENSESAME_CANARY_TOKEN", token)
        .env_remove("OPENSESAME_STORE_PASSWORD")
        .env_remove("OPENSESAME_OPERATOR_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("actual cold detector unavailable");
    let mut input = child.stdin.take().expect("cold detector input unavailable");
    input
        .write_all(REQUEST.as_bytes())
        .expect("actual controlled request refused input");
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().expect("cold detector wait failed") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("cold detector deadline exceeded");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(status.success(), "actual detector exited unsuccessfully");
    let mut bytes = Zeroizing::new(Vec::new());
    child
        .stdout
        .take()
        .expect("cold output unavailable")
        .take(32769)
        .read_to_end(&mut bytes)
        .expect("cold output read failed");
    assert!(bytes.len() <= 32768, "controlled output exceeded bound");
    let text =
        Zeroizing::new(String::from_utf8(bytes.to_vec()).expect("controlled output invalid"));
    assert!(
        !text.contains(token),
        "controlled detector echoed bait identifier"
    );
    text
}
fn owner(journey: &Journey, args: &[&str]) -> TerminalResult {
    let mut all = vec!["security", "canaries"];
    all.extend_from_slice(args);
    journey.current(&all)
}
pub(super) fn run() {
    let journey = Journey::new();
    journey.initialize_historical_passwords();
    let before = journey.snapshot();
    let wrong = journey.run(
        &[
            "security",
            "canaries",
            "create",
            "--kind",
            "mcp-configuration",
        ],
        &[("Current store passphrase", journey.first.as_str())],
    );
    assert!(
        wrong.code != 0,
        "retired credential acquired canary owner authority"
    );
    let created = owner(&journey, &["create", "--kind", "mcp-configuration"]);
    let value = Journey::json(&created);
    let artifact: CreatedArtifact = serde_json::from_value(value["artifact"].clone())
        .expect("actual created artifact unavailable");
    assert!(
        value["configuration"]["mcpServers"]["OpenSesameCanary"].is_object(),
        "actual controlled configuration missing"
    );
    let store = journey.root.to_str().expect("private fixture path invalid");
    let observed = cold(
        &[
            "canary",
            "serve",
            "--store",
            store,
            "--artifact-id",
            &artifact.id,
        ],
        &artifact.presented_id,
    );
    assert!(
        observed.contains("synthetic") && !observed.contains(journey.item.as_str()),
        "controlled detector obtained real data"
    );
    let path = journey.root.join("validator-binding.json");
    let output = path.to_str().expect("binding path invalid");
    let exported = journey.run(
        &[
            "security",
            "canaries",
            "export-validator",
            &artifact.id,
            "--output-file",
            output,
        ],
        &[
            ("Current store passphrase", journey.current.as_str()),
            ("Selected canary identifier", &artifact.presented_id),
        ],
    );
    assert!(exported.code == 0, "fresh terminal validator export failed");
    let binding =
        windows_io::read_bounded(&journey.root, Path::new("validator-binding.json"), 4096)
            .expect("export is not private Windows metadata");
    let binding: opensesame_human_vault::credential_canaries::ValidatorBinding =
        serde_json::from_slice(&binding).expect("export binding invalid");
    let status = Journey::json(&owner(&journey, &["status"]));
    assert!(
        status["events"]
            .as_array()
            .expect("owner event metadata missing")
            .len()
            == 3,
        "controlled phases were not observed"
    );
    assert!(
        !status.to_string().contains(&artifact.presented_id)
            && !status.to_string().contains("digestB64"),
        "owner status exposed sensitive matching material"
    );
    windows_io::create_dir(&journey.root, Path::new("detector"))
        .expect("private standalone directory unavailable");
    let detector = journey.root.join("detector");
    let directory = detector.to_str().expect("detector path invalid");
    let installed = journey.top_level(&[
        "canary",
        "install",
        "--directory",
        directory,
        "--binding-file",
        output,
        "--approve-vault-identity",
        &binding.context.vault_identity,
    ]);
    assert!(
        installed.code == 0,
        "actual terminal metadata installation failed"
    );
    assert!(
        owner(&journey, &["clear-events"]).code == 0,
        "fresh terminal event clearing failed"
    );
    assert!(
        Journey::json(&owner(&journey, &["status"]))["events"]
            .as_array()
            .expect("event array missing")
            .is_empty(),
        "owner events remain"
    );
    assert!(
        owner(&journey, &["remove", &artifact.id]).code == 0,
        "fresh terminal artifact removal failed"
    );
    assert!(
        Journey::json(&owner(&journey, &["status"]))["artifacts"]
            .as_array()
            .expect("artifact array missing")
            .is_empty(),
        "owner artifacts remain"
    );
    let stale = cold(
        &[
            "canary",
            "serve",
            "--store",
            store,
            "--artifact-id",
            &artifact.id,
        ],
        &artifact.presented_id,
    );
    assert!(
        stale.contains("refused"),
        "removed artifact acquired authority"
    );
    let isolated = cold(
        &[
            "canary",
            "serve",
            "--directory",
            directory,
            "--validator-id",
            &binding.validator_id,
        ],
        &artifact.presented_id,
    );
    assert!(
        isolated.contains("synthetic"),
        "standalone metadata detector unavailable"
    );
    assert!(
        !detector.join(".opensesame-key").exists(),
        "installed validator acquired real root material"
    );
    assert!(
        journey
            .top_level(&[
                "canary",
                "status",
                "--directory",
                directory,
                "--validator-id",
                &binding.validator_id
            ])
            .code
            == 0,
        "actual human standalone evidence unavailable"
    );
    assert!(
        journey
            .top_level(&[
                "canary",
                "uninstall",
                "--directory",
                directory,
                "--validator-id",
                &binding.validator_id
            ])
            .code
            == 0,
        "actual human standalone uninstall failed"
    );
    let stale = cold(
        &[
            "canary",
            "serve",
            "--directory",
            directory,
            "--validator-id",
            &binding.validator_id,
        ],
        &artifact.presented_id,
    );
    assert!(
        stale.contains("refused"),
        "uninstalled validator acquired authority"
    );
    before.assert_real_unchanged(&journey);
    assert!(
        journey.read(&journey.current, &["protect", "test"]).code == 0,
        "fresh real owner recovery failed"
    );
}
