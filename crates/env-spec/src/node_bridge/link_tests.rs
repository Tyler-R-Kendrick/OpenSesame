//! A `node` reached through a link is judged where it lives: the directory the
//! link resolves into as well as the `PATH` entry the link sits in.

use super::tests::{dir, host, plant};
use super::*;

use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;

fn chmod(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// `bin/node -> real/node`, `bin` private and `real` of `real_mode`.
fn linked(real_mode: u32) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = dir(0o700);
    let (bin, real) = (root.path().join("bin"), root.path().join("real"));
    std::fs::create_dir(&bin).unwrap();
    std::fs::create_dir(&real).unwrap();
    chmod(&bin, 0o700);
    plant(&real, 0o755);
    chmod(&real, real_mode);
    symlink(real.join("node"), bin.join("node")).unwrap();
    (root, bin, real)
}

#[test]
fn a_node_linked_into_a_directory_anyone_can_write_is_passed_over_and_recorded() {
    let (_root, bin, real) = linked(0o777);
    let on = host(OsStr::new(""), Platform::Unix, None);
    let found = find_node(std::slice::from_ref(&bin), &on);
    assert_eq!(found.node, None);
    assert_eq!(
        found.rejected,
        [(bin.join("node"), Skip::WritableByOthers)],
        "{}",
        real.display()
    );
}

#[test]
fn a_node_linked_into_a_directory_only_the_caller_can_write_is_the_link() {
    let (_root, bin, _real) = linked(0o755);
    let on = host(OsStr::new(""), Platform::Unix, None);
    let found = find_node(std::slice::from_ref(&bin), &on);
    assert_eq!(found.node, Some(bin.join("node")));
    assert!(found.rejected.is_empty());
}

#[test]
fn a_link_inside_the_same_directory_adds_no_second_check() {
    let root = dir(0o700);
    plant(root.path(), 0o755);
    // `node` is a link to a sibling file in the same directory.
    let real = root.path().join("node-22");
    std::fs::rename(root.path().join("node"), &real).unwrap();
    symlink(&real, root.path().join("node")).unwrap();
    let on = host(OsStr::new(""), Platform::Unix, None);
    let found = find_node(&[root.path().to_path_buf()], &on);
    assert_eq!(found.node, Some(root.path().join("node")));
}
