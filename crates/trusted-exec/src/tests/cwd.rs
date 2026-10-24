//! The working directory is never a trusted `PATH` entry on Unix, however
//! `PATH` names it; another directory the caller owns still is.

use super::*;

use std::path::PathBuf;

use crate::testkit::Fixture;

/// A lookup made from `cwd`, with `entries` as its whole `PATH`.
fn from(fixture: &Fixture, cwd: &Path, entries: &[PathBuf]) -> Lookup {
    let mut lookup = fixture.lookup(&[]);
    lookup.vars[0].1 = std::env::join_paths(entries).expect("PATH");
    lookup.cwd = Some(cwd.to_path_buf());
    lookup
}

fn refusal(fixture: &Fixture, cwd: &Path, entries: &[PathBuf]) -> String {
    resolve_in("op", None, &from(fixture, cwd, entries))
        .unwrap_err()
        .to_string()
}

#[test]
fn the_working_directory_named_by_its_absolute_path_is_skipped() {
    let fixture = Fixture::new("op");
    let cwd = fixture.scratch("checkout");
    fixture.stub_planted(&cwd);
    let named = cwd.display().to_string();
    for entry in [named.clone(), format!("{named}/"), format!("{named}/./")] {
        let err = refusal(&fixture, &cwd, &[PathBuf::from(&entry)]);
        let said = format!("\"{entry}\" the current directory");
        assert!(err.contains(&said), "{said} not in: {err}");
    }
    // Behind it the caller's own copy is found, and the planted one never runs.
    let found = resolve_in(
        "op",
        None,
        &from(&fixture, &cwd, &[cwd.clone(), fixture.trusted.clone()]),
    )
    .unwrap();
    assert_eq!(found.program, fixture.trusted.join("op"));
    run(Command::new(&found.program));
    assert!(!fixture.planted_ran());
}

#[test]
fn the_working_directory_through_a_link_is_the_same_directory() {
    let fixture = Fixture::new("op");
    let cwd = fixture.scratch("checkout");
    fixture.stub_planted(&cwd);
    let link = fixture.scratch("links").join("checkout");
    std::os::unix::fs::symlink(&cwd, &link).unwrap();
    // `PATH` names the link; then the working directory is named through it.
    for (entry, here) in [(&link, &cwd), (&cwd, &link)] {
        let err = refusal(&fixture, here, &[entry.clone()]);
        assert!(err.contains("the current directory"), "{err}");
    }
    assert!(!fixture.planted_ran());
}

#[test]
fn another_directory_the_caller_owns_is_still_searched() {
    let fixture = Fixture::new("op");
    let cwd = fixture.scratch("checkout");
    let tools = fixture.scratch("tools");
    fixture.stub_recorder(&tools.join("op"));
    let found = resolve_in("op", None, &from(&fixture, &cwd, &[tools.clone()])).unwrap();
    assert_eq!(found.program, tools.join("op"));
    assert_eq!(found.trusted, vec![tools]);
}

#[test]
fn a_working_directory_that_cannot_be_read_leaves_every_entry_untrusted() {
    let fixture = Fixture::new("op");
    let gone = fixture.scratch("gone");
    std::fs::remove_dir(&gone).unwrap();
    let err = refusal(&fixture, &gone, &[fixture.trusted.clone()]);
    let said = format!(
        "\"{}\" the current directory cannot be read to tell them apart",
        fixture.trusted.display()
    );
    assert!(err.contains(&said), "{said} not in: {err}");
}
