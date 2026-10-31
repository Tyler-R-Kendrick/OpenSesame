//! The AWS mint end to end (ADR 0217), every hop a real process: the
//! `opensesame host run` Host, `opensesame daemon run` over a Unix socket, and
//! the `opensesame-credential-process` helper, with a loopback STS stand-in
//! that verifies `SigV4` with `aws-sigv4` from the secret it was given.
//!
//! The build under test carries the `sts-stand-in` feature, which is the only
//! way the Host reads `OPENSESAME_TEST_AWS_STS_ENDPOINT`; a shipped build has
//! no such knob. What the test proves is what an operator is promised: the
//! helper prints valid `credential_process` JSON for STS's temporary
//! credential, and the IAM key pair, the `ExternalId` and the session token it
//! was signed with appear in no output, log line, event or file on disk.
#![cfg(unix)]

mod helper_stub;
mod named;

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use helper_stub::run_helper;
use opensesame_connection_broker::aws_sts::stand_in::{self, Expect, Reply};
use serde_json::{json, Value};

const OPERATOR: &str = "vtok_dummy_marker_operator_0123456789abcdef";
const AKID: &str = "AKIAVTOKDUMMYMARKER0";
const SECRET: &str = "vtok_dummy_marker_0123456789abcdef";
const SESSION: &str = "vtok_dummy_marker_session_0123456789";
const EXTERNAL_ID: &str = "vtok_dummy_marker_external_0123456789";
const SOURCE: [&str; 4] = [AKID, SECRET, SESSION, EXTERNAL_ID];

/// A child process that is killed when the test ends, however it ends.
struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("address")
        .port()
}

fn spawn(command: &mut Command, log: &Path) -> Process {
    let out = File::create(log).expect("log file");
    let err = out.try_clone().expect("log handle");
    Process(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .spawn()
            .expect("spawn opensesame"),
    )
}

fn wait_for(what: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

struct Host {
    api: String,
    http: reqwest::blocking::Client,
}

impl Host {
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = self
            .http
            .request(
                method.parse().expect("method"),
                format!("{}{path}", self.api),
            )
            .header("x-opensesame-operator", OPERATOR);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().expect("host answers");
        let status = response.status().as_u16();
        let text = response.text().expect("body");
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        )
    }
}

/// Everything the mint could leak through, collected after the run.
fn assert_clean(label: &str, text: &str) {
    for secret in SOURCE {
        assert!(!text.contains(secret), "{label} carries {secret}");
    }
}

fn read_all(dir: &Path, stem: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    for entry in std::fs::read_dir(dir).expect("state dir").flatten() {
        if entry.file_name().to_string_lossy().starts_with(stem) {
            bytes.extend(std::fs::read(entry.path()).unwrap_or_default());
        }
    }
    bytes
}

fn opensesame(dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env_clear()
        .env("HOME", dir)
        .env("OPENSESAME_ENV", "development")
        .env("NODE_ENV", "development")
        .env("OPENSESAME_ALLOW_DEV_DEFAULTS", "1")
        .env("OPENSESAME_OPERATOR_TOKEN", OPERATOR)
        .env(
            "OPENSESAME_CLAIM_PEPPER",
            "vtok_dummy_marker_pepper_0123456789abcdef",
        );
    command
}

struct Stack {
    host: Host,
    /// The daemon's loopback TCP address, for its operator routes.
    daemon: String,
    sock: PathBuf,
    dir: tempfile::TempDir,
    stand_in: stand_in::StandIn,
    _runtime: tokio::runtime::Runtime,
    _processes: Vec<Process>,
}

fn boot(reply: Reply) -> Stack {
    let dir = tempfile::tempdir().expect("state dir");
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let stand_in = runtime.block_on(stand_in::spawn(
        Expect {
            access_key_id: AKID,
            secret: SECRET,
            session_token: Some(SESSION),
            region: "eu-west-1",
        },
        reply,
    ));
    let (host_port, daemon_port) = (free_port(), free_port());
    let api = format!("http://127.0.0.1:{host_port}");
    let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let host = spawn(
        opensesame(dir.path())
            .args(["host", "run", "--listen", &format!("127.0.0.1:{host_port}")])
            .args(["--resource", &api, "--issuer", "http://127.0.0.1:1"])
            .arg("--database-url")
            .arg(format!(
                "sqlite://{}?mode=rwc",
                dir.path().join("host.db").display()
            ))
            .env("OPENSESAME_CONNECTION_KEY", &key)
            .env("OPENSESAME_TEST_AWS_STS_ENDPOINT", &stand_in.base),
        &dir.path().join("host.log"),
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("client");
    wait_for("the Host", || {
        client
            .get(format!("{api}/health/live"))
            .send()
            .is_ok_and(|response| response.status().is_success())
    });
    let sock = dir.path().join("agent.sock");
    let daemon = spawn(
        opensesame(dir.path())
            .args([
                "daemon",
                "run",
                "--listen",
                &format!("127.0.0.1:{daemon_port}"),
            ])
            .arg("--sock")
            .arg(&sock)
            .env("OPENSESAME_HOST_API", &api),
        &dir.path().join("daemon.log"),
    );
    wait_for("the daemon socket", || sock.exists());
    Stack {
        host: Host { api, http: client },
        daemon: format!("http://127.0.0.1:{daemon_port}"),
        sock,
        dir,
        stand_in,
        _runtime: runtime,
        _processes: vec![host, daemon],
    }
}

/// An `aws` connection holding the dummy key pair, opted in and bound.
fn bound_connection(host: &Host) -> String {
    let (status, created) = host.call(
        "POST",
        "/api/v1/connections",
        Some(json!({"provider_id": "aws"})),
    );
    assert_eq!(status, 201, "{created}");
    let id = created["connection_id"].as_str().expect("id").to_string();
    let (status, body) = host.call(
        "POST",
        &format!("/api/v1/connections/{id}/credential"),
        Some(json!({"configuration_set": {
            "region": "eu-west-1",
            "access_key_id": AKID,
            "secret_access_key": SECRET,
            "session_token": SESSION,
        }})),
    );
    assert_eq!(status, 200, "{body}");
    let (status, body) = host.call(
        "PATCH",
        &format!("/api/v1/connections/{id}"),
        Some(json!({"shareability": "private", "max_invoke_level": 2, "materialization": "derived_short_lived"})),
    );
    assert_eq!(status, 200, "{body}");
    let (status, body) = host.call(
        "PUT",
        &format!("/api/v1/connections/{id}/aws-sts-binding"),
        Some(json!({
            "role_arn": "arn:aws:iam::123456789012:role/Deployer",
            "region": "eu-west-1",
            "max_duration_seconds": 1800,
            "external_id": EXTERNAL_ID,
        })),
    );
    assert_eq!(status, 200, "{body}");
    id
}

/// The operator allows the helpers to mint `id` on the daemon's socket with
/// no token (ADR 0138 §2); until then a helper's mint is refused.
fn allow_helpers(stack: &Stack, id: &str) {
    let response = stack
        .host
        .http
        .put(format!("{}/v1/helper-mints/{id}", stack.daemon))
        .header("x-opensesame-operator", OPERATOR)
        .send()
        .expect("daemon over TCP");
    assert_eq!(response.status().as_u16(), 200, "allow {id}");
}

/// The aws helper as an AWS SDK starts it: no operator token, which it would
/// not read anyway — the daemon admits it by its peer credentials (ADR 0138 §2).
fn helper(stack: &Stack, id: &str) -> std::process::Output {
    let sock = stack.sock.to_string_lossy().to_string();
    run_helper(
        &named::binary("opensesame-credential-process"),
        &[],
        "",
        &[
            ("OPENSESAME_AGENT_SOCK", sock.as_str()),
            ("OPENSESAME_AWS_CONNECTION_ID", id),
            ("OPENSESAME_AWS_DURATION_SECONDS", "1800"),
        ],
    )
}

#[test]
fn the_helper_prints_the_minted_credential_and_nothing_leaks() {
    let stack = boot(Reply::Assume { expires_in: 1800 });
    let id = bound_connection(&stack.host);
    allow_helpers(&stack, &id);

    let out = helper(&stack, &id);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(out.status.success(), "helper failed: {stderr}");
    let printed: Value = serde_json::from_slice(&out.stdout).expect("credential_process JSON");
    assert_eq!(printed["Version"], 1);
    assert_eq!(printed["AccessKeyId"], stand_in::MINTED_ACCESS_KEY_ID);
    assert_eq!(printed["SecretAccessKey"], stand_in::MINTED_SECRET);
    assert_eq!(printed["SessionToken"], stand_in::MINTED_SESSION_TOKEN);
    let expiration =
        chrono::DateTime::parse_from_rfc3339(printed["Expiration"].as_str().expect("expiration"))
            .expect("RFC 3339");
    let ahead = (expiration.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds();
    assert!((1500..=1900).contains(&ahead), "expires in {ahead}s");

    let hits = stack.stand_in.hits();
    assert_eq!(hits.len(), 1);
    assert!(
        hits[0].signature_valid,
        "the stand-in could not verify SigV4"
    );
    assert_eq!(hits[0].security_token.as_deref(), Some(SESSION));
    assert_eq!(
        hits[0].form["RoleArn"],
        "arn:aws:iam::123456789012:role/Deployer"
    );
    assert_eq!(hits[0].form["DurationSeconds"], "1800");
    assert_eq!(hits[0].form["ExternalId"], EXTERNAL_ID);
    assert_eq!(hits[0].form["SourceIdentity"], "operator");

    assert_clean("helper stdout", &String::from_utf8_lossy(&out.stdout));
    assert_clean("helper stderr", &stderr);
    let (_, events) = stack
        .host
        .call("GET", &format!("/api/v1/connections/{id}/events"), None);
    assert_clean("connection events", &events.to_string());
    assert!(
        events.to_string().contains(stand_in::REQUEST_ID),
        "{events}"
    );
    let (_, binding) = stack.host.call(
        "GET",
        &format!("/api/v1/connections/{id}/aws-sts-binding"),
        None,
    );
    assert_clean("binding view", &binding.to_string());
    for log in ["host.log", "daemon.log"] {
        let text = String::from_utf8_lossy(&read_all(stack.dir.path(), log)).to_string();
        assert!(
            !text.is_empty(),
            "{log} is empty: the capture is not working"
        );
        assert_clean(log, &text);
        assert!(
            !text.contains(stand_in::MINTED_SECRET),
            "{log} carries the minted secret"
        );
    }
    let disk = String::from_utf8_lossy(&read_all(stack.dir.path(), "host.db")).to_string();
    assert!(disk.len() > 4096, "the database was not captured");
    assert_clean("database files", &disk);
    assert!(
        !disk.contains(stand_in::MINTED_SECRET),
        "the database keeps the minted secret"
    );
}

#[test]
fn an_sts_refusal_reaches_the_helper_as_a_class_and_no_credential() {
    let stack = boot(Reply::Error {
        status: 403,
        code: "AccessDenied",
    });
    let id = bound_connection(&stack.host);
    allow_helpers(&stack, &id);
    let out = helper(&stack, &id);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(
        stderr.contains("502") && stderr.contains("aws.sts.access_denied"),
        "{stderr}"
    );
    assert!(!stderr.contains(stand_in::UPSTREAM_MESSAGE), "{stderr}");
    assert_clean("helper stderr", &stderr);
    assert_eq!(
        stack.stand_in.hits().len(),
        1,
        "AccessDenied is not retried"
    );
}
