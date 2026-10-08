use super::conpty::{Result as TerminalResult, Terminal};
use serde_json::Value;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use zeroize::Zeroizing;

pub(super) struct Journey {
    pub(super) directory: tempfile::TempDir,
    pub(super) root: PathBuf,
    pub(super) first: Zeroizing<String>,
    pub(super) second: Zeroizing<String>,
    pub(super) current: Zeroizing<String>,
    pub(super) item: Zeroizing<String>,
}
impl Journey {
    pub(super) fn new() -> Self {
        let directory = tempfile::tempdir().expect("temporary terminal fixture unavailable");
        std::fs::write(
            directory.path().join(".gitconfig"),
            "[user]\nname = OpenSesame terminal fixture\nemail = fixture@example.invalid\n",
        )
        .expect("isolated fixture git configuration unavailable");
        let root = directory.path().join("store");
        let secret = || Zeroizing::new(uuid::Uuid::new_v4().to_string());
        Self {
            directory,
            root,
            first: secret(),
            second: secret(),
            current: secret(),
            item: secret(),
        }
    }
    pub(super) fn terminal(&self, args: &[&str]) -> io::Result<Terminal> {
        let mut arguments = vec![OsString::from("pass")];
        arguments.extend(args.iter().map(|argument| OsString::from(*argument)));
        arguments.push("--path".into());
        arguments.push(self.root.as_os_str().into());
        Terminal::spawn(
            std::path::Path::new(env!("CARGO_BIN_EXE_opensesame")),
            &arguments,
            self.directory.path(),
        )
    }
    pub(super) fn run(&self, args: &[&str], answers: &[(&str, &str)]) -> TerminalResult {
        let mut terminal = self
            .terminal(args)
            .expect("actual terminal process unavailable");
        for (prompt, secret) in answers {
            terminal
                .answer(prompt, secret)
                .expect("actual hidden prompt failed");
        }
        let mut protected = vec![
            self.first.as_str(),
            self.second.as_str(),
            self.current.as_str(),
        ];
        protected.extend(answers.iter().map(|(_, value)| *value));
        terminal
            .finish(&protected)
            .expect("actual terminal completion or privacy check failed")
    }
    pub(super) fn current(&self, args: &[&str]) -> TerminalResult {
        self.run(args, &[("Current store passphrase", &self.current)])
    }
    pub(super) fn read(&self, password: &str, args: &[&str]) -> TerminalResult {
        self.run(args, &[("Store passphrase", password)])
    }
    pub(super) fn initialize_historical_passwords(&self) {
        let initialized = self.run(
            &["init"],
            &[
                ("New store passphrase", &self.first),
                ("Confirm passphrase", &self.first),
            ],
        );
        assert!(
            initialized.code == 0,
            "actual terminal initialization failed"
        );
        let inserted = self.run(
            &["insert", "Owner/private"],
            &[
                ("Store passphrase", &self.first),
                ("Enter password for Owner/private", &self.item),
            ],
        );
        assert!(inserted.code == 0, "actual terminal insertion failed");
        self.rotate(&self.first, &self.second);
        self.rotate(&self.second, &self.current);
        assert!(
            self.read(&self.first, &["protect", "test"]).code != 0,
            "first credential was not revoked"
        );
        assert!(
            self.read(&self.second, &["protect", "test"]).code != 0,
            "second credential was not revoked"
        );
    }
    fn rotate(&self, old: &str, next: &str) {
        let result = self.run(
            &["protect", "rewrap", "--yes"],
            &[
                ("Current store passphrase", old),
                ("New store passphrase", next),
                ("Confirm new store passphrase", next),
            ],
        );
        assert!(
            result.code == 0,
            "actual root-rotating password change failed"
        );
    }
    pub(super) fn enroll(&self, retired: &str, synthetic: bool) -> String {
        let mut arguments = vec![
            "security",
            "retired",
            "enroll",
            "--acknowledge-verifier-risk",
        ];
        if synthetic {
            arguments.extend(["--response", "synthetic-decoy"]);
        }
        let result = self.run(
            &arguments,
            &[
                ("Current store passphrase", &self.current),
                ("Selected retired passphrase", retired),
            ],
        );
        assert!(result.code == 0, "actual terminal trap enrollment failed");
        let id = result
            .visible
            .lines()
            .find_map(|line| line.trim().strip_prefix("enrolled "))
            .expect("actual enrolled trap identifier missing");
        uuid::Uuid::parse_str(id).expect("invalid trap identifier");
        id.to_owned()
    }
    pub(super) fn status(&self) -> Value {
        let result = self.current(&["security", "retired", "status"]);
        assert!(
            result.code == 0,
            "actual terminal metadata authentication failed"
        );
        let json = result
            .visible
            .lines()
            .find(|line| line.trim().starts_with('{'))
            .expect("actual metadata JSON missing");
        let value: Value = serde_json::from_str(json).expect("invalid metadata JSON");
        assert!(
            !json.contains("verifier") && !json.contains("salt"),
            "status exposed verifier data"
        );
        value
    }
    pub(super) fn top_level(&self, args: &[&str]) -> TerminalResult {
        let args = args.iter().map(OsString::from).collect::<Vec<_>>();
        Terminal::spawn(
            std::path::Path::new(env!("CARGO_BIN_EXE_opensesame")),
            &args,
            self.directory.path(),
        )
        .expect("actual top-level terminal unavailable")
        .finish(&[
            self.first.as_str(),
            self.second.as_str(),
            self.current.as_str(),
        ])
        .expect("actual top-level terminal completion or privacy check failed")
    }
    pub(super) fn json(result: &TerminalResult) -> Value {
        assert!(result.code == 0, "actual canary owner command failed");
        let raw = result
            .visible
            .lines()
            .find(|line| line.trim().starts_with('{'))
            .expect("actual canary JSON unavailable");
        serde_json::from_str(raw).expect("actual canary JSON invalid")
    }
    pub(super) fn snapshot(&self) -> Snapshot {
        Snapshot {
            key: Zeroizing::new(
                std::fs::read(self.root.join(".opensesame-key")).expect("fixture key unavailable"),
            ),
            item: Zeroizing::new(
                std::fs::read(self.root.join("Owner/private.osseal"))
                    .expect("fixture ciphertext unavailable"),
            ),
            records: match std::fs::read(self.root.join(".opensesame-retired-credentials.json")) {
                Ok(bytes) => Some(Zeroizing::new(bytes)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(_) => panic!("fixture records unreadable"),
            },
        }
    }
}
pub(super) struct Snapshot {
    key: Zeroizing<Vec<u8>>,
    item: Zeroizing<Vec<u8>>,
    records: Option<Zeroizing<Vec<u8>>>,
}
impl Snapshot {
    pub(super) fn assert_real_unchanged(&self, journey: &Journey) {
        let next = journey.snapshot();
        assert!(
            *self.key == *next.key && *self.item == *next.item,
            "real key or ciphertext changed unexpectedly"
        );
    }
    pub(super) fn assert_all_unchanged(&self, journey: &Journey) {
        self.assert_real_unchanged(journey);
        assert!(
            self.records == journey.snapshot().records,
            "retained records changed unexpectedly"
        );
    }
}
