//! Harness for the real-server suites: the pinned nats-server started from
//! the shipped `ops/nats/*.conf` templates, a disposable PKI, nkeys, free
//! loopback ports, and specs built through the env resolver.

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use opensesame_domain::transport::PeerIdentitySelector;
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf, LeafSpec, SanEntry};

use crate::nats_transport::NatsTransportSpec;

pub(crate) const SERVER_NAME: &str = "localhost";

pub(crate) fn enabled() -> bool {
    std::env::var("OPENSESAME_MTLS_FIXTURES").as_deref() == Ok("1")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

pub(crate) fn ops_conf(name: &str) -> PathBuf {
    repo_root().join("ops/nats").join(name)
}

/// The pinned nats-server (env from `scripts/mtls/mtls-integration-test.sh`, or
/// fetched + sha256-verified through `scripts/mtls/mtls-fixtures.sh`).
pub(crate) fn server_bin() -> PathBuf {
    if let Ok(path) = std::env::var("OPENSESAME_MTLS_BIN_NATS_SERVER") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    let out = Command::new("bash")
        .arg(repo_root().join("scripts/mtls/mtls-fixtures.sh"))
        .args(["path", "nats-server"])
        .output()
        .expect("scripts/mtls/mtls-fixtures.sh path nats-server");
    assert!(
        out.status.success(),
        "fixture fetch failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
}

pub(crate) fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port()
}

pub(crate) fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).expect("write fixture");
    path
}

/// An nkey user: `(seed, public key)`.
pub(crate) fn user_nkey() -> (String, String) {
    let kp = nkeys::KeyPair::new_user();
    (kp.seed().expect("seed"), kp.public_key())
}

/// Bounded wait for a condition (never an unbounded spin in a test).
pub(crate) async fn wait_until(mut ready: impl FnMut() -> bool, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if ready() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ready()
}

/// Disposable PKI for one test: a client CA, a server leaf for `localhost`,
/// and an unrelated CA to build "wrong" material from.
pub(crate) struct Pki {
    pub ca: DisposableCa,
    pub other_ca: DisposableCa,
    pub dir: tempfile::TempDir,
    pub ca_pem: PathBuf,
    pub server_cert: PathBuf,
    pub server_key: PathBuf,
}

impl Pki {
    pub(crate) fn new() -> Self {
        let ca = DisposableCa::new("opensesame-nats-test-ca");
        let other_ca = DisposableCa::new("unrelated-ca");
        let dir = tempfile::tempdir().expect("tempdir");
        let ca_pem = write(dir.path(), "ca.pem", &ca.ca_pem());
        let server = ca.issue_server(SERVER_NAME);
        let server_dir = dir.path().join("server");
        std::fs::create_dir_all(&server_dir).expect("server dir");
        let (server_cert, server_key) = server.write_to(&server_dir);
        Self {
            ca,
            other_ca,
            dir,
            ca_pem,
            server_cert,
            server_key,
        }
    }

    /// A client leaf from the trusted CA with one DNS SAN.
    pub(crate) fn client(&self, san: &str) -> IssuedLeaf {
        self.ca
            .issue_client(PeerIdentitySelector::DnsName(san.to_owned()))
    }

    /// A leaf usable as both client and server (a route certificate).
    pub(crate) fn route_leaf(ca: &DisposableCa) -> IssuedLeaf {
        ca.issue_with(&LeafSpec {
            common_name: "route".to_owned(),
            server_auth: true,
            client_auth: true,
            sans: vec![
                SanEntry::Dns(SERVER_NAME.to_owned()),
                SanEntry::Ip("127.0.0.1".parse().expect("ip")),
            ],
            ..LeafSpec::default()
        })
    }

    /// Write a leaf as `<name>.crt` / `<name>.key`.
    pub(crate) fn write_leaf(&self, name: &str, leaf: &IssuedLeaf) -> (PathBuf, PathBuf) {
        let sub = self.dir.path().join(name);
        std::fs::create_dir_all(&sub).expect("leaf dir");
        leaf.write_to(&sub)
    }

    /// A client spec built the way production builds it: through the env
    /// resolver, from references. `identity`/`seed` are optional so the
    /// no-certificate and no-credential negatives use the same path.
    pub(crate) fn client_spec(
        &self,
        identity: Option<&IssuedLeaf>,
        seed: Option<&str>,
        tls_first: bool,
    ) -> NatsTransportSpec {
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("OPENSESAME_NATS_REQUIRE_TLS".into(), "1".into());
        vars.insert(
            "OPENSESAME_NATS_TLS_TRUST_FILE".into(),
            self.ca_pem.display().to_string(),
        );
        vars.insert(
            "OPENSESAME_NATS_TLS_TRUST_KIND".into(),
            "private_root".into(),
        );
        vars.insert("OPENSESAME_NATS_TLS_SERVER_NAME".into(), SERVER_NAME.into());
        vars.insert("OPENSESAME_NATS_MAX_RECONNECTS".into(), "2".into());
        if tls_first {
            vars.insert("OPENSESAME_NATS_TLS_FIRST".into(), "1".into());
        }
        if let Some(leaf) = identity {
            let (cert, key) = self.write_leaf(&leaf.thumbprint[..12], leaf);
            vars.insert("OPENSESAME_NATS_TLS_IDENTITY_SOURCE".into(), "pem".into());
            vars.insert(
                "OPENSESAME_NATS_TLS_CERT_FILE".into(),
                cert.display().to_string(),
            );
            vars.insert(
                "OPENSESAME_NATS_TLS_KEY_FILE".into(),
                key.display().to_string(),
            );
        }
        if let Some(seed) = seed {
            let path = write(
                self.dir.path(),
                &format!("{}.seed", &seed[1..9]),
                seed.as_bytes(),
            );
            vars.insert("OPENSESAME_NATS_AUTH".into(), "nkey".into());
            vars.insert(
                "OPENSESAME_NATS_NKEY_SEED_FILE".into(),
                path.display().to_string(),
            );
        }
        NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| vars.get(name).cloned())
            .expect("spec")
            .expect("spec present")
    }
}

/// A running nats-server, killed on drop.
pub(crate) struct Server {
    child: Child,
    pub port: u16,
    pub log: PathBuf,
    _store: tempfile::TempDir,
}

impl Server {
    /// Start `ops/nats/<conf>` with `-DV` and the given environment.
    pub(crate) fn start(conf: &str, env: &[(&str, String)]) -> Self {
        Self::start_with_args(conf, env, &[])
    }

    /// [`Self::start`] with extra command-line flags (they override the
    /// file, which is how the fixed-port `local-dev.conf` gets a free port).
    pub(crate) fn start_with_args(conf: &str, env: &[(&str, String)], args: &[String]) -> Self {
        let store = tempfile::tempdir().expect("store dir");
        let port = env
            .iter()
            .find(|(k, _)| *k == "OPENSESAME_NATS_LISTEN")
            .and_then(|(_, v)| v.rsplit(':').next())
            .and_then(|p| p.parse().ok())
            .expect("listen port");
        let log = store.path().join("server.log");
        let log_file = std::fs::File::create(&log).expect("log file");
        let mut cmd = Command::new(server_bin());
        cmd.arg("-c").arg(ops_conf(conf)).arg("-DV").args(args);
        cmd.env(
            "OPENSESAME_NATS_STORE_DIR",
            store.path().join("js").display().to_string(),
        );
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.stdout(Stdio::from(log_file.try_clone().expect("clone")))
            .stderr(Stdio::from(log_file));
        let child = cmd.spawn().expect("spawn nats-server");
        let server = Self {
            child,
            port,
            log,
            _store: store,
        };
        server.wait_ready();
        server
    }

    fn wait_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if std::net::TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "nats-server on {} did not become ready:\n{}",
            self.port,
            self.log_text()
        );
    }

    pub(crate) fn url(&self) -> String {
        format!("tls://{SERVER_NAME}:{}", self.port)
    }

    pub(crate) fn log_text(&self) -> String {
        let mut text = String::new();
        if let Ok(mut file) = std::fs::File::open(&self.log) {
            let _ = file.read_to_string(&mut text);
        }
        text
    }

    /// Wait (bounded) until the log contains `needle`.
    pub(crate) fn wait_log(&self, needle: &str, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if self.log_text().contains(needle) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    pub(crate) fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.kill();
    }
}

/// The shared environment for `secure-client.conf`: one nkey per role.
pub(crate) struct Roles {
    pub system: (String, String),
    pub provisioner: (String, String),
    pub host: (String, String),
    pub publisher: (String, String),
    pub consumer: (String, String),
    pub backup: (String, String),
    pub callout: (String, String),
    /// Discovery-only user in the callout account (`$SRV.>` requests).
    pub callout_observer: (String, String),
    /// Curve seed of the callout service (`auth_callout.xkey` names its
    /// public key in `secure-callout.conf`).
    pub callout_xkey: String,
}

impl Roles {
    pub(crate) fn new() -> Self {
        Self {
            system: user_nkey(),
            provisioner: user_nkey(),
            host: user_nkey(),
            publisher: user_nkey(),
            consumer: user_nkey(),
            backup: user_nkey(),
            callout: user_nkey(),
            callout_observer: user_nkey(),
            callout_xkey: nkeys::XKey::new().seed().expect("xkey seed"),
        }
    }

    /// The callout service's curve key.
    pub(crate) fn callout_xkey(&self) -> nkeys::XKey {
        nkeys::XKey::from_seed(&self.callout_xkey).expect("xkey")
    }

    pub(crate) fn env(&self, pki: &Pki, port: u16) -> Vec<(&'static str, String)> {
        vec![
            ("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{port}")),
            ("OPENSESAME_NATS_SERVER_NAME", format!("test-{port}")),
            (
                "OPENSESAME_NATS_TLS_SERVER_CERT",
                pki.server_cert.display().to_string(),
            ),
            (
                "OPENSESAME_NATS_TLS_SERVER_KEY",
                pki.server_key.display().to_string(),
            ),
            (
                "OPENSESAME_NATS_TLS_CLIENT_CA",
                pki.ca_pem.display().to_string(),
            ),
            ("OPENSESAME_NATS_NKEY_SYSTEM", self.system.1.clone()),
            (
                "OPENSESAME_NATS_NKEY_PROVISIONER",
                self.provisioner.1.clone(),
            ),
            ("OPENSESAME_NATS_NKEY_HOST", self.host.1.clone()),
            ("OPENSESAME_NATS_NKEY_PUBLISHER", self.publisher.1.clone()),
            ("OPENSESAME_NATS_NKEY_CONSUMER", self.consumer.1.clone()),
            ("OPENSESAME_NATS_NKEY_BACKUP", self.backup.1.clone()),
            ("OPENSESAME_NATS_NKEY_CALLOUT", self.callout.1.clone()),
            (
                "OPENSESAME_NATS_NKEY_CALLOUT_OBSERVER",
                self.callout_observer.1.clone(),
            ),
            (
                "OPENSESAME_NATS_CALLOUT_XKEY",
                self.callout_xkey().public_key(),
            ),
        ]
    }
}

/// Start `secure-client.conf` on a free port.
pub(crate) fn secure_server(pki: &Pki, roles: &Roles) -> Server {
    let port = free_port();
    Server::start("secure-client.conf", &roles.env(pki, port))
}
