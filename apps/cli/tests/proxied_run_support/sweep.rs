//! Looking for a value where it must not be: in the files a run left behind,
//! and in the command line and environment of every process the test's user
//! can read.

use std::path::{Path, PathBuf};

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// Every file under `dir` whose bytes hold `needle`.
pub fn files_naming(dir: &Path, needle: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // A symlink is a path, not a second copy of what it points at.
        if entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
            continue;
        }
        if path.is_dir() {
            found.extend(files_naming(&path, needle));
        } else if std::fs::read(&path).is_ok_and(|bytes| contains(&bytes, needle.as_bytes())) {
            found.push(path);
        }
    }
    found
}

/// `pid file` for every readable `/proc/<pid>/cmdline` and
/// `/proc/<pid>/environ` that holds `needle`. Linux only; elsewhere nothing is
/// readable, so the answer is empty and a caller's control (a decoy that must
/// be found) says so.
pub fn processes_naming(needle: &str) -> Vec<String> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return found;
    };
    for entry in entries.flatten() {
        let pid = entry.file_name().to_string_lossy().into_owned();
        if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        for file in ["cmdline", "environ"] {
            let held = std::fs::read(entry.path().join(file))
                .is_ok_and(|bytes| contains(&bytes, needle.as_bytes()));
            if held {
                found.push(format!("{pid} {file}"));
            }
        }
    }
    found
}

/// Whether this platform lets the test read other processes' command lines.
pub fn can_read_processes() -> bool {
    Path::new("/proc/self/environ").exists()
}

/// The pids of live processes running the executable at `exe`.
pub fn processes_running(exe: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return found;
    };
    for entry in entries.flatten() {
        let pid = entry.file_name().to_string_lossy().into_owned();
        if std::fs::read_link(entry.path().join("exe")).is_ok_and(|link| link == exe) {
            found.push(pid);
        }
    }
    found
}
