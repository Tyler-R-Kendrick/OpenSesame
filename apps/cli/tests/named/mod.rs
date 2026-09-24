//! Start the built `opensesame` under a helper's name, the way git, Docker or
//! a browser starts it: through a link whose file name picks the program.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// A link named `name` to the built `opensesame`, in a directory kept for
/// this test run.
pub fn binary(name: &str) -> String {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    let dir = DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!(
            "opensesame-helpers-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("helper link directory");
        dir
    });
    let path = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    if let Err(error) = link(Path::new(env!("CARGO_BIN_EXE_opensesame")), &path) {
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::AlreadyExists,
            "link {name}: {error}"
        );
    }
    path.to_string_lossy().into_owned()
}

#[cfg(unix)]
fn link(exe: &Path, path: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(exe, path)
}

#[cfg(not(unix))]
fn link(exe: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::copy(exe, path).map(|_| ())
}
