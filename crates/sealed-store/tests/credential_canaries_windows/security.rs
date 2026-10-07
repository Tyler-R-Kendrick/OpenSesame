use super::*;
#[test]
fn windows_detector_private_key_state_acl_hardlink_and_junction_refuse() {
    const KEY: &str = ".opensesame-observation-device-key.v1";
    const STATE: &str = ".opensesame-credential-canaries.v1";
    for name in [KEY, STATE] {
        let dir = store();
        let root = dir.path();
        let artifact = create(root, b"current owner", ArtifactKind::McpConfiguration).unwrap();
        let before = std::fs::read(root.join(name)).unwrap();
        std::fs::hard_link(root.join(name), root.join("alias-record")).unwrap();
        assert!(observe(root, &artifact.id, &artifact.presented_id, Phase::Connected).is_err());
        assert!(clear_events(root, b"current owner").is_err());
        assert_eq!(std::fs::read(root.join(name)).unwrap(), before);
        std::fs::remove_file(root.join("alias-record")).unwrap();
        assert!(Command::new("icacls.exe")
            .arg(root.join(name))
            .args(["/grant", "*S-1-1-0:R"])
            .status()
            .unwrap()
            .success());
        assert!(status(root, b"current owner").is_err());
        assert_eq!(std::fs::read(root.join(name)).unwrap(), before);
    }
    let dir = store();
    let root = dir.path();
    let artifact = create(root, b"current owner", ArtifactKind::McpConfiguration).unwrap();
    let state = std::fs::read(root.join(STATE)).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let alias = outside.path().join("alias");
    assert!(Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&alias)
        .arg(root)
        .status()
        .unwrap()
        .success());
    assert!(observe(
        &alias,
        &artifact.id,
        &artifact.presented_id,
        Phase::Connected
    )
    .is_err());
    windows_io::remove(root, Path::new(KEY)).unwrap();
    assert!(status(root, b"current owner").is_err());
    assert!(!root.join(KEY).exists());
    assert_eq!(std::fs::read(root.join(STATE)).unwrap(), state);
}
#[test]
fn windows_standalone_validator_private_install_rootless_observe_and_uninstall() {
    const REQUEST: &str = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"canary.status","arguments":{}}}"#;
    const FILE: &str = ".opensesame-installed-canary-validator.v1";
    let dir = store();
    let root = dir.path();
    let artifact = create(root, b"current owner", ArtifactKind::McpConfiguration).unwrap();
    let binding =
        export_validator(root, b"current owner", &artifact.id, &artifact.presented_id).unwrap();
    windows_io::create_dir(root, Path::new("detector")).unwrap();
    let detector = root.join("detector");
    let raw = serde_json::to_string(&binding).unwrap();
    validator::install(&detector, &raw, false).unwrap();
    assert!(validator::install(&detector, &raw, false).is_err());
    remove(root, b"current owner", &artifact.id).unwrap();
    let real = std::fs::read(root.join(".opensesame-key")).unwrap();
    assert!(validator::handle(
        &detector,
        &binding.validator_id,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        REQUEST
    )
    .is_err());
    let result = validator::handle(
        &detector,
        &binding.validator_id,
        &artifact.presented_id,
        REQUEST,
    )
    .unwrap()
    .unwrap();
    assert!(result.to_string().contains("synthetic"));
    assert!(!detector.join(".opensesame-key").exists());
    let evidence = validator::status(&detector, &binding.validator_id).unwrap();
    assert!(!evidence.contains(&artifact.presented_id));
    std::fs::hard_link(detector.join(FILE), detector.join("alias-record")).unwrap();
    assert!(validator::handle(
        &detector,
        &binding.validator_id,
        &artifact.presented_id,
        REQUEST
    )
    .is_err());
    assert!(validator::uninstall(&detector, &binding.validator_id).is_err());
    std::fs::remove_file(detector.join("alias-record")).unwrap();
    validator::uninstall(&detector, &binding.validator_id).unwrap();
    assert!(validator::handle(
        &detector,
        &binding.validator_id,
        &artifact.presented_id,
        REQUEST
    )
    .is_err());
    assert_eq!(std::fs::read(root.join(".opensesame-key")).unwrap(), real);
}
