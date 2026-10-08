//! The actual CLI entrypoint must reach argument parsing on every native host.
//! Unit-test executables do not exercise the production process main stack.

use std::process::Command;

#[test]
fn the_real_cli_prints_its_version_before_dispatching_a_command() {
    let output = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .arg("--version")
        .output()
        .expect("run the genuine CLI executable");
    assert!(output.status.success(), "version failed: {output:?}");
    assert_eq!(
        String::from_utf8(output.stdout)
            .expect("version is UTF-8")
            .trim(),
        format!("opensesame {}", env!("CARGO_PKG_VERSION")),
    );
    assert!(output.stderr.is_empty(), "{:?}", output.stderr);
}
