//! What the bridge is handed of the parent's environment, beyond the table in
//! `tests.rs`: no `PATH` when nothing is trusted, and a shim's data directories.

use super::tests::os;
use super::*;

use std::collections::BTreeSet;

#[test]
fn with_no_trusted_entry_the_bridge_has_no_path_not_an_empty_one() {
    // An empty PATH means the working directory to execvp and every shell.
    let vars = os(&[("HOME", "/home/dummy"), ("PATH", "/tmp/planted")]);
    let got = bridge_environment(&vars, &[], Platform::Unix).unwrap();
    assert!(got.iter().all(|(name, _)| name != "PATH"), "{got:?}");
}

#[test]
fn a_version_managers_shim_is_told_where_it_lives() {
    let vars = os(&[
        ("VOLTA_HOME", "/home/dummy/.volta"),
        ("ASDF_DATA_DIR", "/home/dummy/.asdf"),
        ("MISE_DATA_DIR", "/home/dummy/.mise"),
        ("XDG_DATA_HOME", "/home/dummy/.local/share"),
        ("OPENSESAME_NODE", "/x"),
    ]);
    let got = bridge_environment(&vars, &[PathBuf::from("/usr/bin")], Platform::Unix).unwrap();
    let names: BTreeSet<_> = got.iter().map(|(n, _)| n.to_str().unwrap()).collect();
    assert_eq!(
        names,
        BTreeSet::from([
            "ASDF_DATA_DIR",
            "MISE_DATA_DIR",
            "PATH",
            "VOLTA_HOME",
            "XDG_DATA_HOME"
        ])
    );
}
