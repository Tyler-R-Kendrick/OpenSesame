//! Actual hidden terminal pairing and cold sender processes; no external receiver or owner secrets.
#![cfg(unix)]
#[path = "support/prepared_observation_owner.rs"]
mod peer;
#[path = "support/observation_server.rs"]
mod server;
#[path = "support/canary_terminal.rs"]
mod terminal;
use opensesame_human_vault::credential_canaries::{receiver::ClosedEvent, ArtifactKind};
use std::{
    net::TcpListener,
    process::{Command, Stdio},
};
use terminal::{fixture, human, serve};
fn status(root: &std::path::Path) -> serde_json::Value {
    let output = human(root, &["receiver", "status"], &["generated owner"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn configure(
    root: &std::path::Path,
    provision: &opensesame_human_vault::credential_canaries::receiver::Provision,
) {
    let file = server::pairing_file(root, provision);
    let result = human(
        root,
        &[
            "receiver",
            "configure",
            "--provision-file",
            file.to_str().unwrap(),
        ],
        &["generated owner"],
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(status(root)["receiver"]["verified"], false);
    assert_eq!(status(root)["receiver"]["enabled"], false);
}
#[test]
fn terminal_pairing_authenticated_ack_enable_and_cold_detector_sender_never_unlock_real_root() {
    let root = fixture();
    let original = std::fs::read(root.path().join(".opensesame-key")).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let provision = server::provision(&listener);
    configure(root.path(), &provision);
    let premature = human(root.path(), &["receiver", "enable"], &["generated owner"]);
    assert!(!premature.status.success());
    let worker = std::thread::spawn(move || {
        let mut observations = Vec::new();
        for _ in 0..2 {
            let mut stream = server::accept(&listener);
            let packet = server::read_request(&mut stream);
            observations.push(server::valid_response(&mut stream, &packet, &provision));
        }
        observations
    });
    let test = human(root.path(), &["receiver", "test"], &["generated owner"]);
    assert!(
        test.status.success(),
        "{}",
        String::from_utf8_lossy(&test.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&test.stdout).unwrap()["delivered"],
        true
    );
    let enabled = human(root.path(), &["receiver", "enable"], &["generated owner"]);
    assert!(enabled.status.success());
    let bait = opensesame_sealed_store::credential_canaries::create(
        root.path(),
        b"generated owner",
        ArtifactKind::McpConfiguration,
    )
    .unwrap();
    let observed = serve(
        root.path(),
        &bait.id,
        &bait.presented_id,
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n",
    );
    assert!(observed.status.success());
    let flushed = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["pass", "security", "receiver", "flush", "--path"])
        .arg(root.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        flushed.status.success(),
        "{}",
        String::from_utf8_lossy(&flushed.stderr)
    );
    let observations = worker.join().unwrap();
    assert!(matches!(observations[0].event, ClosedEvent::ReceiverTest));
    assert!(matches!(
        observations[1].event,
        ClosedEvent::ControlledCanaryObserved { .. }
    ));
    let result = status(root.path());
    assert_eq!(result["receiver"]["verified"], true);
    assert_eq!(result["receiver"]["enabled"], true);
    assert_eq!(result["queued"], 0);
    assert!(!result.to_string().contains(&bait.presented_id));
    assert_eq!(
        std::fs::read(root.path().join(".opensesame-key")).unwrap(),
        original
    );
    assert!(
        opensesame_sealed_store::unlock_store_key(root.path(), bait.presented_id.as_bytes())
            .is_err()
    );
    // Independently exercise the actual fresh hidden-terminal removal ceremony, without HTTP held.
    let removed = human(root.path(), &["receiver", "remove"], &["generated owner"]);
    assert!(removed.status.success());
    assert!(status(root.path())["receiver"].is_null());
    assert_eq!(
        std::fs::read(root.path().join(".opensesame-key")).unwrap(),
        original
    );
}
#[test]
fn http_success_and_redirect_without_authenticated_ack_never_verify_or_follow() {
    for redirect in [false, true] {
        let root = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let provision = server::provision(&listener);
        configure(root.path(), &provision);
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let location = format!(
            "Location: http://{}/v1/credential-observations\r\n",
            target.local_addr().unwrap()
        );
        let worker = std::thread::spawn(move || {
            let mut stream = server::accept(&listener);
            server::read_request(&mut stream);
            server::respond(
                &mut stream,
                if redirect { "302 Found" } else { "200 OK" },
                "{}",
                if redirect { &location } else { "" },
            );
        });
        let tested = human(root.path(), &["receiver", "test"], &["generated owner"]);
        assert!(
            tested.status.success(),
            "{}",
            String::from_utf8_lossy(&tested.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&tested.stdout).unwrap()["delivered"],
            false
        );
        worker.join().unwrap();
        assert!(
            matches!(target.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
        );
        assert_eq!(status(root.path())["receiver"]["verified"], false);
        assert!(
            !human(root.path(), &["receiver", "enable"], &["generated owner"])
                .status
                .success()
        );
    }
}
#[test]
fn prepared_peer_revocation_while_genuine_ack_is_pending_does_not_restore_binding() {
    let root = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let provision = server::provision(&listener);
    configure(root.path(), &provision);
    let peer = peer::PreparedOwner::prove(root.path(), b"generated owner");
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut stream = server::accept(&listener);
        let packet = server::read_request(&mut stream);
        let started = std::time::Instant::now();
        started_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        let observed = server::valid_response(&mut stream, &packet, &provision);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "genuine ACK must be sent inside the original fixture window"
        );
        observed
    });
    let path = root.path().to_owned();
    let actor =
        std::thread::spawn(move || human(&path, &["receiver", "test"], &["generated owner"]));
    started_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    // Genuine owner proof was prepared before HTTP; commit the latest sealed state under flock.
    peer.remove_latest_receiver();
    release_tx.send(()).unwrap();
    let tested = actor.join().unwrap();
    assert!(tested.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&tested.stdout).unwrap()["delivered"],
        false
    );
    assert!(matches!(
        worker.join().unwrap().event,
        ClosedEvent::ReceiverTest
    ));
    assert!(status(root.path())["receiver"].is_null());
    assert_eq!(status(root.path())["queued"], 0);
}
#[test]
fn pairing_import_refuses_symlink_hardlink_and_public_key_files_without_disclosing_material() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for kind in ["symlink", "hardlink", "public"] {
        let root = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let provision = server::provision(&listener);
        let file = server::pairing_file(root.path(), &provision);
        let alias = root.path().join("import.json");
        match kind {
            "symlink" => symlink(&file, &alias).unwrap(),
            "hardlink" => std::fs::hard_link(&file, &alias).unwrap(),
            _ => {
                std::fs::rename(&file, &alias).unwrap();
                std::fs::set_permissions(&alias, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
        }
        let result = human(
            root.path(),
            &[
                "receiver",
                "configure",
                "--provision-file",
                alias.to_str().unwrap(),
            ],
            &["generated owner"],
        );
        assert!(!result.status.success());
        assert!(!String::from_utf8_lossy(&result.stdout)
            .contains(&provision.independent_key_material_b64));
        assert!(!String::from_utf8_lossy(&result.stderr)
            .contains(&provision.independent_key_material_b64));
        assert!(status(root.path())["receiver"].is_null());
    }
}
#[test]
fn prepared_peer_password_rewrap_while_genuine_ack_is_pending_cannot_verify_old_owner_test() {
    let root = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let provision = server::provision(&listener);
    configure(root.path(), &provision);
    let peer = peer::PreparedOwner::prove(root.path(), b"generated owner");
    let next = peer.prepare_rewrap(b"generated owner", b"fresh generated owner");
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut stream = server::accept(&listener);
        let packet = server::read_request(&mut stream);
        let started = std::time::Instant::now();
        started_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        let observed = server::valid_response(&mut stream, &packet, &provision);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "genuine ACK must be sent inside the original fixture window"
        );
        observed
    });
    let path = root.path().to_owned();
    let actor =
        std::thread::spawn(move || human(&path, &["receiver", "test"], &["generated owner"]));
    started_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    peer.commit_rewrap(&next);
    release_tx.send(()).unwrap();
    let tested = actor.join().unwrap();
    assert!(
        tested.status.success(),
        "{}",
        String::from_utf8_lossy(&tested.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&tested.stdout).unwrap()["delivered"],
        false
    );
    assert!(matches!(
        worker.join().unwrap().event,
        ClosedEvent::ReceiverTest
    ));
    assert!(opensesame_sealed_store::unlock_store_key(root.path(), b"generated owner").is_err());
    let current = human(
        root.path(),
        &["receiver", "status"],
        &["fresh generated owner"],
    );
    assert!(current.status.success());
    let current: serde_json::Value = serde_json::from_slice(&current.stdout).unwrap();
    assert_eq!(current["receiver"]["verified"], false);
    assert_eq!(current["receiver"]["enabled"], false);
    assert!(!human(
        root.path(),
        &["receiver", "enable"],
        &["fresh generated owner"]
    )
    .status
    .success());
}
