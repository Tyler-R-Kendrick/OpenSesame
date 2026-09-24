//! A real, TLS-enabled, client-certificate-requiring `OpenBao` for the
//! certificate-auth integration test (ADR 0132, AT-OPENBAO-REAL).
//!
//! Everything is disposable and loopback-only: a fresh CA per run, a
//! `tempfile` directory that takes the file storage backend and the PEMs with
//! it, and a port the kernel chose. The server is started from the pinned,
//! sha256-verified `bao` binary `scripts/mtls/mtls-fixtures.sh` fetches — never a
//! system install and never `sudo`.
//!
//! The listener is configured exactly as `OpenBao`'s own documentation requires
//! for the `cert` auth method (<https://openbao.org/docs/configuration/listener/tcp/>):
//!
//! ```hcl
//! tls_cert_file, tls_key_file, tls_client_ca_file
//! tls_require_and_verify_client_cert = true
//! ```
//!
//! That last line is the whole point. A `bao server -dev` runs plaintext and
//! cannot authenticate a certificate at all, so a `-dev` run would prove
//! nothing about this path; here a caller with no client certificate is
//! rejected by the listener before any handler sees it.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use opensesame_domain::transport::{
    PeerIdentitySelector, TlsVersion, TrustProfileKind, TrustProfileRef,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{reqwest_builder, ClientProfile, TrustBundle};
use serde_json::{json, Value};

/// The DNS identity the server certificate carries and the client verifies.
/// The connection is dialed at 127.0.0.1 and `reqwest`'s `resolve` maps the
/// name onto it, so the reference identity is checked for real.
pub const SERVER_DNS: &str = "bao.example";

pub const ROLE_A: &str = "role-a";
pub const ROLE_B: &str = "role-b";
pub const POLICY_READ: &str = "connector-read";
pub const ALLOWED_PATH: &str = "connector/data/allowed";
pub const FORBIDDEN_PATH: &str = "connector/data/forbidden";

/// Skip (rather than fail) unless the operator asked for fixture-backed runs.
#[must_use]
pub fn fixtures_enabled() -> bool {
    std::env::var("OPENSESAME_MTLS_FIXTURES").is_ok_and(|value| value == "1")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root")
}

fn bao_binary() -> PathBuf {
    let root = repo_root();
    let out = Command::new("bash")
        .arg(root.join("scripts/mtls/mtls-fixtures.sh"))
        .args(["path", "openbao"])
        .output()
        .expect("scripts/mtls/mtls-fixtures.sh path openbao");
    assert!(
        out.status.success(),
        "mtls-fixtures.sh failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("port")
        .local_addr()
        .expect("addr")
        .port()
}

/// A running, initialized, unsealed `OpenBao` with the `cert` auth method
/// configured and two roles whose SAN constraints differ.
pub struct LiveBao {
    pub port: u16,
    pub ca: DisposableCa,
    pub foreign_ca: DisposableCa,
    pub client_a: IssuedLeaf,
    pub client_b: IssuedLeaf,
    root_token: String,
    child: Child,
    log_path: PathBuf,
    _dir: tempfile::TempDir,
}

impl Drop for LiveBao {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl LiveBao {
    /// The base URL a client uses. The host is the certificate's identity;
    /// the address is loopback.
    #[must_use]
    pub fn base(&self) -> String {
        format!("https://{SERVER_DNS}:{}", self.port)
    }

    /// A `reqwest` client for `identity` (or none), trusting `trust_ca`.
    ///
    /// Built through `opensesame_transport_security::reqwest_builder`, so the
    /// profile is the validated one the Host would use: no proxy, no extra
    /// roots, and the exact expected server identity.
    ///
    /// # Panics
    ///
    /// When the profile or the client cannot be built.
    #[must_use]
    pub fn client(
        &self,
        identity: Option<&IssuedLeaf>,
        trust_ca: &DisposableCa,
    ) -> reqwest::Client {
        let profile = ClientProfile {
            server_trust: TrustBundle::from_pem(
                TrustProfileRef::new("bao-root").expect("ref"),
                TrustProfileKind::PrivateRoot,
                &trust_ca.root_pem(),
            )
            .expect("trust"),
            server_name: opensesame_transport_security::ServerNamePolicy::Dns(SERVER_DNS.into()),
            identity: identity.map(|leaf| std::sync::Arc::new(leaf.identity())),
            min_version: TlsVersion::Tls12,
        };
        reqwest_builder(&profile, reqwest::Client::builder())
            .expect("client profile")
            .no_proxy()
            .resolve(
                SERVER_DNS,
                format!("127.0.0.1:{}", self.port).parse().expect("addr"),
            )
            .timeout(Duration::from_secs(10))
            .build()
            .expect("client")
    }

    async fn admin(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let client = self.client(Some(&self.client_a), &self.ca);
        let mut request = client
            .request(method, format!("{}{path}", self.base()))
            .header("X-Vault-Token", &self.root_token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect("admin request");
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    /// Read a KV v2 path with `token`, returning the HTTP status.
    ///
    /// # Panics
    ///
    /// When the request cannot be sent.
    pub async fn read_with_token(&self, token: &str, path: &str) -> u16 {
        self.client(Some(&self.client_a), &self.ca)
            .get(format!("{}/v1/{path}", self.base()))
            .header("X-Vault-Token", token)
            .send()
            .await
            .expect("read")
            .status()
            .as_u16()
    }

    /// Remove a cert role: the certificate's *authorization* is revoked, and
    /// no new login with it can succeed.
    ///
    /// # Panics
    ///
    /// When the request fails.
    pub async fn delete_role(&self, role: &str) {
        let (status, _) = self
            .admin(
                reqwest::Method::DELETE,
                &format!("/v1/auth/cert/certs/{role}"),
                None,
            )
            .await;
        assert!((200..300).contains(&status), "delete role: {status}");
    }

    /// Boot, initialize, unseal and configure a live `OpenBao`.
    ///
    /// # Panics
    ///
    /// When the binary cannot be started or the server does not become ready.
    pub async fn start() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let ca = DisposableCa::new("bao-root");
        let foreign_ca = DisposableCa::new("stranger-root");
        let server = ca.issue_server(SERVER_DNS);
        let (cert_path, key_path) = server.write_to(dir.path());
        let ca_path = dir.path().join("client-ca.pem");
        std::fs::write(&ca_path, ca.root_pem()).expect("client ca");
        let port = free_port();
        let config = dir.path().join("config.hcl");
        let mut file = std::fs::File::create(&config).expect("config");
        write!(
            file,
            r#"storage "file" {{ path = "{storage}" }}
listener "tcp" {{
  address = "127.0.0.1:{port}"
  tls_cert_file = "{cert}"
  tls_key_file = "{key}"
  tls_client_ca_file = "{client_ca}"
  tls_require_and_verify_client_cert = true
  tls_min_version = "tls12"
}}
api_addr = "https://127.0.0.1:{port}"
"#,
            storage = dir.path().join("data").display(),
            cert = cert_path.display(),
            key = key_path.display(),
            client_ca = ca_path.display(),
        )
        .expect("write config");
        std::fs::create_dir_all(dir.path().join("data")).expect("storage dir");

        let log_path = dir.path().join("server.log");
        let log = std::fs::File::create(&log_path).expect("server log");
        let child = Command::new(bao_binary())
            .args(["server", &format!("-config={}", config.display())])
            .stdout(Stdio::from(log.try_clone().expect("log handle")))
            .stderr(Stdio::from(log))
            .spawn()
            .expect("spawn bao");

        let mut bao = Self {
            port,
            ca,
            foreign_ca,
            client_a: ca_client(&dir, "a.clients.example"),
            client_b: ca_client(&dir, "b.clients.example"),
            root_token: String::new(),
            child,
            log_path,
            _dir: dir,
        };
        // The leaves must come from the *same* CA the listener trusts.
        bao.client_a = bao
            .ca
            .issue_client(PeerIdentitySelector::DnsName("a.clients.example".into()));
        bao.client_b = bao
            .ca
            .issue_client(PeerIdentitySelector::DnsName("b.clients.example".into()));
        bao.wait_ready().await;
        bao.initialize().await;
        bao.configure().await;
        bao
    }

    async fn wait_ready(&self) {
        let client = self.client(Some(&self.client_a), &self.ca);
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if client
                .get(format!("{}/v1/sys/health", self.base()))
                .send()
                .await
                .is_ok()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let log = std::fs::read_to_string(&self.log_path).unwrap_or_default();
        panic!(
            "openbao did not become reachable on 127.0.0.1:{}\n{}",
            self.port,
            log.lines().rev().take(20).collect::<Vec<_>>().join("\n")
        );
    }

    async fn initialize(&mut self) {
        let (status, body) = self
            .admin(
                reqwest::Method::PUT,
                "/v1/sys/init",
                Some(json!({"secret_shares": 1, "secret_threshold": 1})),
            )
            .await;
        assert!((200..300).contains(&status), "init: {status} {body}");
        let key = body["keys"][0].as_str().expect("unseal key").to_owned();
        body["root_token"]
            .as_str()
            .expect("root token")
            .clone_into(&mut self.root_token);
        let (status, body) = self
            .admin(
                reqwest::Method::PUT,
                "/v1/sys/unseal",
                Some(json!({ "key": key })),
            )
            .await;
        assert!((200..300).contains(&status), "unseal: {status} {body}");
        assert_eq!(body["sealed"], json!(false));
    }

    async fn configure(&self) {
        let ca_pem = String::from_utf8(self.ca.root_pem()).expect("ca pem");
        let steps: Vec<(reqwest::Method, String, Value)> = vec![
            (
                reqwest::Method::POST,
                "/v1/sys/auth/cert".into(),
                json!({"type": "cert"}),
            ),
            (
                reqwest::Method::POST,
                "/v1/sys/mounts/connector".into(),
                json!({"type": "kv", "options": {"version": "2"}}),
            ),
            (
                reqwest::Method::PUT,
                format!("/v1/sys/policies/acl/{POLICY_READ}"),
                json!({"policy": format!("path \"{ALLOWED_PATH}\" {{ capabilities = [\"read\"] }}")}),
            ),
            (
                reqwest::Method::POST,
                format!("/v1/auth/cert/certs/{ROLE_A}"),
                json!({
                    "certificate": ca_pem,
                    "allowed_dns_sans": "a.clients.example",
                    "token_policies": POLICY_READ,
                    "token_ttl": 3600,
                }),
            ),
            (
                reqwest::Method::POST,
                format!("/v1/auth/cert/certs/{ROLE_B}"),
                json!({
                    "certificate": ca_pem,
                    "allowed_dns_sans": "b.clients.example",
                    "token_policies": "connector-admin",
                    "token_ttl": 3600,
                }),
            ),
            (
                reqwest::Method::POST,
                format!("/v1/{ALLOWED_PATH}"),
                json!({"data": {"value": "ok"}}),
            ),
            (
                reqwest::Method::POST,
                format!("/v1/{FORBIDDEN_PATH}"),
                json!({"data": {"value": "not-for-this-role"}}),
            ),
        ];
        for (method, path, body) in steps {
            let (status, answer) = self.admin(method, &path, Some(body)).await;
            assert!((200..300).contains(&status), "{path}: {status} {answer}");
        }
    }
}

/// Placeholder leaf used only while the struct is assembled; replaced with a
/// leaf from the live CA immediately afterwards.
fn ca_client(_dir: &tempfile::TempDir, dns: &str) -> IssuedLeaf {
    DisposableCa::new("placeholder").issue_client(PeerIdentitySelector::DnsName(dns.into()))
}
