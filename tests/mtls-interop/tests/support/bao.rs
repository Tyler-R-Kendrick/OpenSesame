//! A disposable, genuinely TLS-enabled `OpenBao` with certificate auth.
//!
//! This is SW-INTEROP's own harness, not SW-CONNECTOR's: the PKI comes from
//! the system `openssl` and every request is made by `curl`, so neither the
//! certificates nor the client share code with the production connector. The
//! only thing under test is the *server's* behaviour.
//!
//! `bao server -dev` is plaintext and cannot authenticate a certificate at
//! all, so it is never used here. The listener is configured with
//! `tls_require_and_verify_client_cert = true`, and
//! [`Bao::plaintext_is_refused`] proves that before anything else runs.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};
use opensesame_mtls_interop::pki::{Ca, Leaf, LeafSpec, Pki};
use opensesame_mtls_interop::proc::{free_port, run_bounded, Child};
use opensesame_mtls_interop::{fixture_binary, fixture_version};
use serde_json::{json, Value};

/// The reference identity the listener's certificate carries.
pub const SERVER_DNS: &str = "bao.iop.test";

/// One `curl` exchange.
pub struct Answer {
    /// `curl`'s own exit code: 0 means the TLS session was established.
    pub curl_exit: i32,
    /// The HTTP status, when there was a response.
    pub status: u16,
    /// The parsed body, when it was JSON.
    pub body: Value,
}

impl Answer {
    /// `curl` never completed the TLS session.
    #[must_use]
    pub fn is_transport_failure(&self) -> bool {
        self.curl_exit != 0
    }
}

/// A running `OpenBao` plus the disposable world around it.
pub struct Bao {
    pub port: u16,
    pub version: String,
    pub pki: Pki,
    pub ca: Ca,
    pub foreign_ca: Ca,
    /// Tenant A's client identity, and tenant B's, from the same trusted CA.
    pub tenant_a: Leaf,
    pub tenant_b: Leaf,
    /// A leaf from an unrelated root carrying tenant A's DNS name.
    pub impostor: Leaf,
    root_token: String,
    _child: Child,
}

impl Bao {
    /// `https://bao.iop.test:<port>`, resolved to loopback by `curl`.
    #[must_use]
    pub fn base(&self) -> String {
        format!("https://{SERVER_DNS}:{}", self.port)
    }

    /// One `curl` request. `client` selects the presented identity;
    /// `token` becomes `X-Vault-Token`.
    ///
    /// # Errors
    ///
    /// `curl` could not be spawned.
    pub fn request(
        &self,
        method: &str,
        path: &str,
        client: Option<&Leaf>,
        anchors: &Path,
        token: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Answer> {
        let url = format!("{}{path}", self.base());
        let mut args: Vec<String> = vec![
            "-sS".into(),
            // The container exports HTTPS_PROXY, and `bao.iop.test` is not in
            // its no_proxy list, so without this every request would be sent
            // to the agent proxy and read as a transport failure.
            "--noproxy".into(),
            "*".into(),
            "--max-time".into(),
            "20".into(),
            "--resolve".into(),
            format!("{SERVER_DNS}:{}:127.0.0.1", self.port),
            "--cacert".into(),
            anchors.to_string_lossy().into_owned(),
            "-X".into(),
            method.to_string(),
            "-w".into(),
            "\n%{http_code}".into(),
            url,
        ];
        if let Some(client) = client {
            args.push("--cert".into());
            args.push(client.chain.to_string_lossy().into_owned());
            args.push("--key".into());
            args.push(client.key.to_string_lossy().into_owned());
        }
        if let Some(token) = token {
            args.push("-H".into());
            args.push(format!("X-Vault-Token: {token}"));
        }
        if let Some(body) = body {
            args.push("-H".into());
            args.push("content-type: application/json".into());
            args.push("--data-binary".into());
            args.push(body.to_string());
        }
        let (code, stdout, _stderr) = run_bounded(
            Command::new("/usr/bin/curl").args(&args),
            Duration::from_secs(30),
        )?;
        let curl_exit = code.unwrap_or(-1);
        let mut lines: Vec<&str> = stdout.rsplitn(2, '\n').collect();
        lines.reverse();
        let (payload, status_text) = match lines.as_slice() {
            [payload, status] => (*payload, *status),
            _ => ("", stdout.trim()),
        };
        Ok(Answer {
            curl_exit,
            status: status_text.trim().parse().unwrap_or(0),
            body: serde_json::from_str(payload).unwrap_or(Value::Null),
        })
    }

    /// An administrative call with the root token and tenant A's identity.
    ///
    /// # Errors
    ///
    /// The request could not be made or the server refused it.
    pub fn admin(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Answer> {
        let answer = self.request(
            method,
            path,
            Some(&self.tenant_a),
            &self.ca.cert,
            Some(&self.root_token),
            body,
        )?;
        if !(200..300).contains(&answer.status) {
            bail!("admin {method} {path}: {} {}", answer.status, answer.body);
        }
        Ok(answer)
    }

    /// Certificate login for one role.
    ///
    /// # Errors
    ///
    /// `curl` could not run.
    pub fn login(&self, client: Option<&Leaf>, anchors: &Path, role: &str) -> Result<Answer> {
        self.request(
            "POST",
            "/v1/auth/cert/login",
            client,
            anchors,
            None,
            Some(&json!({ "name": role })),
        )
    }

    /// Probe the port with plaintext HTTP. Returns `(curl exit, status,
    /// first line of the body)`.
    ///
    /// Go's TLS listener answers a plaintext request with a `400` whose body
    /// says an HTTP request reached an HTTPS server, so the assertion is not
    /// "curl failed" but "no API answer came back" — the distinction matters,
    /// because a `bao server -dev` would answer `200` here with real health
    /// JSON and every other result in this suite would be meaningless.
    ///
    /// # Errors
    ///
    /// `curl` could not run.
    pub fn plaintext_probe(&self) -> Result<(i32, u16, String)> {
        let (code, stdout, _err) = run_bounded(
            Command::new("/usr/bin/curl").args([
                "-sS",
                "--noproxy",
                "*",
                "--max-time",
                "10",
                "-w",
                "\n%{http_code}",
                &format!("http://127.0.0.1:{}/v1/sys/health", self.port),
            ]),
            Duration::from_secs(20),
        )?;
        let mut parts: Vec<&str> = stdout.rsplitn(2, '\n').collect();
        parts.reverse();
        let (body, status) = match parts.as_slice() {
            [body, status] => (*body, *status),
            _ => ("", stdout.trim()),
        };
        Ok((
            code.unwrap_or(-1),
            status.trim().parse().unwrap_or(0),
            body.trim().to_string(),
        ))
    }

    /// Boot, initialise, unseal and configure two tenants.
    ///
    /// # Errors
    ///
    /// Anything in that sequence.
    pub fn start() -> Result<Self> {
        let binary = fixture_binary("openbao")?;
        let version = fixture_version("openbao")?;
        let pki = Pki::new()?;
        let ca = pki.root("iop-bao-root")?;
        let foreign_ca = pki.root("iop-bao-foreign-root")?;
        let server = ca.issue(&LeafSpec::server("bao", SERVER_DNS))?;
        let tenant_a = ca.issue(&LeafSpec::client_dns("tenant-a", "a.tenants.iop.test"))?;
        let tenant_b = ca.issue(&LeafSpec::client_dns("tenant-b", "b.tenants.iop.test"))?;
        let impostor = foreign_ca.issue(&LeafSpec::client_dns("impostor", "a.tenants.iop.test"))?;
        let port = free_port()?;
        let config = write_config(pki.dir(), port, &server, &ca.cert)?;
        std::fs::create_dir_all(pki.dir().join("data"))?;
        let mut child = Child::spawn(
            "bao",
            Command::new(&binary).args(["server", &format!("-config={}", config.display())]),
            &pki.dir().join("bao.log"),
        )?;
        child.wait_for_port(port, Duration::from_secs(60))?;
        let mut bao = Self {
            port,
            version,
            pki,
            ca,
            foreign_ca,
            tenant_a,
            tenant_b,
            impostor,
            root_token: String::new(),
            _child: child,
        };
        bao.wait_for_api()?;
        bao.initialise()?;
        bao.configure()?;
        Ok(bao)
    }

    fn wait_for_api(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let reachable = self
                .request(
                    "GET",
                    "/v1/sys/health",
                    Some(&self.tenant_a),
                    &self.ca.cert,
                    None,
                    None,
                )
                .is_ok_and(|answer| answer.curl_exit == 0);
            if reachable {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        bail!("openbao did not answer over TLS on 127.0.0.1:{}", self.port)
    }

    fn initialise(&mut self) -> Result<()> {
        let init = self.request(
            "PUT",
            "/v1/sys/init",
            Some(&self.tenant_a),
            &self.ca.cert,
            None,
            Some(&json!({"secret_shares": 1, "secret_threshold": 1})),
        )?;
        let key = init.body["keys"][0]
            .as_str()
            .context("no unseal key")?
            .to_owned();
        init.body["root_token"]
            .as_str()
            .context("no root token")?
            .clone_into(&mut self.root_token);
        let unseal = self.request(
            "PUT",
            "/v1/sys/unseal",
            Some(&self.tenant_a),
            &self.ca.cert,
            None,
            Some(&json!({ "key": key })),
        )?;
        if unseal.body["sealed"] != json!(false) {
            bail!("openbao stayed sealed: {}", unseal.body);
        }
        Ok(())
    }

    /// Two tenants, two roles, two policies, two KV paths. Each role's SAN
    /// constraint names exactly one client identity.
    fn configure(&self) -> Result<()> {
        let ca_pem = std::fs::read_to_string(&self.ca.cert)?;
        self.admin("POST", "/v1/sys/auth/cert", Some(&json!({"type": "cert"})))?;
        self.admin(
            "POST",
            "/v1/sys/mounts/connector",
            Some(&json!({"type": "kv", "options": {"version": "2"}})),
        )?;
        for (tenant, san) in [("a", "a.tenants.iop.test"), ("b", "b.tenants.iop.test")] {
            self.admin(
                "PUT",
                &format!("/v1/sys/policies/acl/tenant-{tenant}-read"),
                Some(&json!({"policy": format!(
                    "path \"connector/data/tenant-{tenant}/*\" {{ capabilities = [\"read\"] }}"
                )})),
            )?;
            self.admin(
                "POST",
                &format!("/v1/auth/cert/certs/tenant-{tenant}"),
                Some(&json!({
                    "certificate": ca_pem,
                    "allowed_dns_sans": san,
                    "token_policies": format!("tenant-{tenant}-read"),
                    "token_ttl": 3600,
                })),
            )?;
            self.admin(
                "POST",
                &format!("/v1/connector/data/tenant-{tenant}/secret"),
                Some(&json!({"data": {"value": format!("tenant-{tenant}-only")}})),
            )?;
        }
        Ok(())
    }
}

fn write_config(dir: &Path, port: u16, server: &Leaf, client_ca: &Path) -> Result<PathBuf> {
    let config = dir.join("bao.hcl");
    std::fs::write(
        &config,
        format!(
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
disable_mlock = true
"#,
            storage = dir.join("data").display(),
            cert = server.chain.display(),
            key = server.key.display(),
            client_ca = client_ca.display(),
        ),
    )?;
    Ok(config)
}
