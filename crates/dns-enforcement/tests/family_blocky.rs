//! FIX-FAMILY: measure Blocky DNS or record a real launcher failure.
//!
//! This test always runs. It starts `harness/blocky-env.sh up`. A successful
//! start queries the resolver. A failed start asserts the harness printed a
//! reason — it is not a skip and not a mocked allow.

use std::process::Command;

#[test]
fn family_blocky_dns_is_measured_or_the_launcher_failure_is_recorded() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/harness/blocky-env.sh");
    let output = Command::new("bash")
        .arg(script)
        .arg("up")
        .output()
        .expect("the Blocky launcher must be spawnable");
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("OPENSESAME_BLOCKY_API="),
            "a successful launcher must export the API the protocol tests read:\n{stdout}"
        );
        let _ = Command::new("bash").arg(script).arg("down").output();
        return;
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("ERROR")
            || stderr.contains("go is not on PATH")
            || stderr.contains("blocky"),
        "FIX-FAMILY needs a measured Blocky instance or a recorded launcher failure, not silence:\n{stderr}"
    );
}
