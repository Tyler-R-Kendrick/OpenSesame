//! A shipped build has no door for aiming the broker's upstream elsewhere.
//!
//! The `upstream-override` feature exists for tests and the acceptance run. In
//! a build without it, the module, the code that reads it and the name of the
//! variable that arms it are not in the binary at all, so no environment can
//! redirect a person's credential, whatever it says.

#![cfg(not(feature = "upstream-override"))]

use std::path::Path;

const BIN: &str = env!("CARGO_BIN_EXE_opensesame-surrogate-proxy");

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[test]
fn the_override_variable_is_not_in_the_shipped_binary() {
    let bytes = std::fs::read(Path::new(BIN)).unwrap();
    for needle in [
        "OPENSESAME_SURROGATE_TEST_UPSTREAM",
        "requests admitted for",
        "TEST BUILD",
    ] {
        assert!(
            !contains(&bytes, needle.as_bytes()),
            "{needle} is in a build without the upstream-override feature"
        );
    }
    // The control: the binary is the plugin, and the check can see strings.
    assert!(contains(&bytes, b"plugin_not_active"));
}
