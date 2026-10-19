//! A planted `PATH` for the tests of code that starts a program (feature
//! `testkit`, Unix only).
//!
//! [`Fixture::new`] makes a directory anyone can write holding a `program`
//! that leaves a marker if it ever runs, followed on `PATH` by a private
//! directory holding a `program` that writes its environment and arguments
//! down and exits 0. [`Fixture::lookup`] is a parent environment with that
//! `PATH` and the secrets and loader settings no child may be handed
//! ([`HOSTILE`]); hand it to the code's `*_in` builder, run the command, and
//! read what happened.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::{Caller, Lookup, Platform};

/// The dummy secret a parent holds that must never reach a child.
pub const SECRET: &str = "vtok_dummy_marker_0123456789abcdef";

/// A parent environment no child may inherit any of: the Host's keys, a
/// GitHub App key, cloud credentials and git's own redirections.
pub const HOSTILE: [(&str, &str); 8] = [
    ("OPENSESAME_CONNECTION_KEY", SECRET),
    ("OPENSESAME_STORE_PASSWORD", SECRET),
    ("GITHUB_APP_PRIVATE_KEY", SECRET),
    ("AWS_SECRET_ACCESS_KEY", SECRET),
    ("GIT_CONFIG_PARAMETERS", "'core.pager'='planted'"),
    ("GIT_CONFIG_COUNT", "1"),
    ("GIT_EXEC_PATH", "/nonexistent/planted-exec-path"),
    ("GIT_DIR", "/nonexistent/planted-git-dir"),
];

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// The two directories, what the stubs leave behind, and the stub's name.
pub struct Fixture {
    root: PathBuf,
    pub planted: PathBuf,
    pub trusted: PathBuf,
    pub marker: PathBuf,
    pub dump: PathBuf,
    pub program: String,
}

fn write_script(path: &Path, body: &str, mode: u32) {
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).expect("write stub");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod stub");
}

impl Fixture {
    /// A planted and a trusted `program`, the planted one first on `PATH`.
    ///
    /// # Panics
    ///
    /// When the temporary directories or stubs cannot be written.
    #[must_use]
    pub fn new(program: &str) -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        // The real path of the temporary directory: macOS's is a link, and a
        // program is run by its real path.
        let temp = std::env::temp_dir();
        let temp = temp.canonicalize().unwrap_or(temp);
        let root = temp.join(format!("trusted-exec-{}-{n}-{program}", std::process::id()));
        let (planted, trusted) = (root.join("planted"), root.join("trusted"));
        for dir in [&root, &planted, &trusted] {
            std::fs::create_dir_all(dir).expect("fixture directory");
        }
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        std::fs::set_permissions(&trusted, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        std::fs::set_permissions(&planted, std::fs::Permissions::from_mode(0o777)).expect("chmod");
        let fixture = Self {
            marker: root.join("planted-ran"),
            dump: root.join("dump"),
            planted,
            trusted,
            root,
            program: program.to_owned(),
        };
        fixture.stub_planted(&fixture.planted);
        fixture.stub_recorder(&fixture.trusted.join(program));
        fixture
    }

    /// A `program` in `dir` that leaves the marker if it ever runs.
    ///
    /// # Panics
    ///
    /// When the stub cannot be written.
    pub fn stub_planted(&self, dir: &Path) {
        let body = format!("echo planted > '{}'\nexit 0", self.marker.display());
        write_script(&dir.join(&self.program), &body, 0o755);
    }

    /// A program at `path` that writes its environment, then its arguments
    /// after a `--args--` line, to the dump file and exits 0.
    ///
    /// # Panics
    ///
    /// When the stub cannot be written.
    pub fn stub_recorder(&self, path: &Path) {
        self.stub_recorder_saying(path, "");
    }

    /// [`Fixture::stub_recorder`] that also prints `stdout` (a line a caller
    /// parses, such as a remote's URL).
    ///
    /// # Panics
    ///
    /// When the stub cannot be written.
    pub fn stub_recorder_saying(&self, path: &Path, stdout: &str) {
        self.stub_recorder_with(path, ":", stdout);
    }

    /// [`Fixture::stub_recorder_saying`] that first runs the shell line
    /// `first` (`/bin/cat > /dev/null` for a program fed on stdin).
    ///
    /// # Panics
    ///
    /// When the stub cannot be written.
    pub fn stub_recorder_with(&self, path: &Path, first: &str, stdout: &str) {
        let dump = self.dump.display();
        let body = format!(
            "{first}\n/usr/bin/env > '{dump}'\necho --args-- >> '{dump}'\nfor a in \"$@\"; do echo \"$a\" >> '{dump}'; done\nprintf '%s' '{stdout}'\nexit 0"
        );
        write_script(path, &body, 0o755);
    }

    /// `PATH` = planted then trusted, a `HOME`, [`HOSTILE`], then `extra`.
    ///
    /// # Panics
    ///
    /// When the two directories cannot be joined into a `PATH`.
    #[must_use]
    pub fn lookup(&self, extra: &[(&str, &str)]) -> Lookup {
        let path = std::env::join_paths([&self.planted, &self.trusted]).expect("PATH");
        let mut vars = vec![
            (OsString::from("PATH"), path),
            (OsString::from("HOME"), self.root.clone().into_os_string()),
        ];
        for (name, value) in HOSTILE.iter().chain(extra) {
            vars.push((OsString::from(name), OsString::from(value)));
        }
        Lookup {
            vars,
            cwd: None,
            platform: Platform::Unix,
            caller: Caller::current(),
        }
    }

    /// A new private directory `name` inside the fixture, removed with it.
    ///
    /// # Panics
    ///
    /// When it cannot be made.
    #[must_use]
    pub fn scratch(&self, name: &str) -> PathBuf {
        let dir = self.root.join(name);
        std::fs::create_dir_all(&dir).expect("scratch directory");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        dir
    }

    /// Whether the planted program ran.
    #[must_use]
    pub fn planted_ran(&self) -> bool {
        self.marker.exists()
    }

    /// The environment the recording stub was given, if it ran.
    #[must_use]
    pub fn env(&self) -> Option<BTreeMap<String, String>> {
        let text = std::fs::read_to_string(&self.dump).ok()?;
        let env = text.split("\n--args--\n").next()?;
        Some(
            env.lines()
                .filter_map(|line| line.split_once('='))
                .map(|(n, v)| (n.to_owned(), v.to_owned()))
                .collect(),
        )
    }

    /// The arguments the recording stub was given, if it ran.
    #[must_use]
    pub fn args(&self) -> Option<Vec<String>> {
        let text = std::fs::read_to_string(&self.dump).ok()?;
        let (_, args) = text.split_once("--args--\n")?;
        Some(args.lines().map(str::to_owned).collect())
    }

    /// Fails the test when the planted program ran, the recorder did not, or
    /// any part of [`HOSTILE`] reached it; returns what it was given.
    ///
    /// # Panics
    ///
    /// On any of those.
    #[must_use]
    pub fn assert_clean(&self) -> BTreeMap<String, String> {
        assert!(!self.planted_ran(), "the planted {} ran", self.program);
        let env = self
            .env()
            .unwrap_or_else(|| panic!("the trusted {} did not run", self.program));
        for (name, _) in HOSTILE {
            assert!(!env.contains_key(name), "{name} reached {}", self.program);
        }
        assert!(
            !env.values().any(|value| value.contains(SECRET)),
            "the dummy secret reached {}",
            self.program
        );
        env
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
