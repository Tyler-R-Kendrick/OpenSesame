use super::journey::Journey;

pub(super) fn run() {
    let journey = Journey::new();
    journey.initialize_historical_passwords();
    let before = journey.snapshot();
    let reject_id = journey.enroll(&journey.first, false);
    let synthetic_id = journey.enroll(&journey.second, true);
    let status = journey.status();
    let traps = status["traps"]
        .as_array()
        .expect("metadata trap array missing");
    assert!(
        traps.len() == 2
            && traps[0]["response"] == "reject"
            && traps[1]["response"] == "synthetic_decoy",
        "actual terminal responses did not preserve selected policy"
    );
    let rejected = journey.read(&journey.first, &["show", "Owner/private", "--reveal"]);
    assert!(
        rejected.code != 0
            && !rejected.visible.contains(journey.item.as_str())
            && !rejected.visible.contains("synthetic-"),
        "reject trap disclosed an item"
    );
    let decoy = journey.read(&journey.second, &["show", "Example/account", "--reveal"]);
    assert!(
        decoy.code == 0
            && decoy.visible.contains("synthetic-")
            && !decoy.visible.contains(journey.item.as_str()),
        "synthetic terminal admission escaped its fixture realm"
    );
    let inventory = journey.read(&journey.second, &["ls"]);
    assert!(
        inventory.code == 0
            && inventory.visible.contains("Example/account")
            && !inventory.visible.contains("Owner/private"),
        "synthetic inventory contains real entries"
    );
    let export = journey.directory.path().join("escaped.kdbx");
    for arguments in [
        vec!["rm", "Owner/private"],
        vec!["backup"],
        vec![
            "export-kdbx",
            export.to_str().expect("fixture path UTF8"),
            "--reveal",
        ],
    ] {
        assert!(
            journey.read(&journey.second, &arguments).code != 0,
            "retired credential acquired production authority"
        );
    }
    assert!(
        !export.exists(),
        "synthetic credential produced a real export"
    );
    before.assert_real_unchanged(&journey);
    let owner = journey.read(&journey.current, &["show", "Owner/private", "--reveal"]);
    assert!(
        owner.code == 0 && owner.visible.contains(journey.item.as_str()),
        "fresh current owner recovery failed"
    );
    assert!(
        !journey.status()["events"]
            .as_array()
            .expect("metadata events missing")
            .is_empty(),
        "retired observations missing"
    );
    assert!(
        journey
            .current(&["security", "retired", "remove", &reject_id])
            .code
            == 0,
        "terminal reject trap removal failed"
    );
    assert!(
        journey.status()["traps"]
            .as_array()
            .expect("trap array missing")
            .len()
            == 1,
        "removal changed wrong scope"
    );
    assert!(
        journey
            .current(&["security", "retired", "clear-events"])
            .code
            == 0,
        "terminal evidence clearing failed"
    );
    assert!(
        journey.status()["events"]
            .as_array()
            .expect("event array missing")
            .is_empty(),
        "evidence was not cleared"
    );
    assert!(
        journey
            .current(&["security", "retired", "remove", &synthetic_id])
            .code
            == 0,
        "terminal synthetic trap removal failed"
    );
    assert!(
        journey.status()["traps"]
            .as_array()
            .expect("trap array missing")
            .is_empty(),
        "terminal traps remain"
    );
    for retired in [&journey.first, &journey.second] {
        assert!(
            journey
                .read(retired, &["show", "Example/account", "--reveal"])
                .code
                != 0,
            "removed retired credential regained authority"
        );
    }
    assert!(
        journey
            .read(&journey.current, &["show", "Owner/private", "--reveal"])
            .code
            == 0,
        "owner lost availability"
    );
    before.assert_real_unchanged(&journey);
}
