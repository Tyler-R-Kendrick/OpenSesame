//! One `opensesame dev run --agent -- <child>`: the child, what it was
//! given, what it asked for, and what the run printed.
//!
//! The child is `child.mjs`, started as an agent would start a tool that takes
//! a token on its command line: `sh -c 'exec node child.mjs <out>
//! --token "$VERCEL_TOKEN"'`. It records its environment and arguments, then
//! makes the requests of its plan through the run's proxy.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Child, ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::upstream::Upstream;
use super::{display, Sandbox, HOST, STORE_PASSPHRASE};

const CHILD_SCRIPT: &str = include_str!("child.mjs");
const OVERRIDE_ENV: &str = "OPENSESAME_SURROGATE_TEST_UPSTREAM";

/// One request in the child's plan, against `api.vercel.com` unless `host`
/// says otherwise, carrying the surrogate unless `authorization` says not.
pub fn request(label: &str, method: &str, path: &str) -> Value {
    json!({
        "label": label, "host": HOST, "method": method, "path": path,
        "authorization": "surrogate",
    })
}

/// [`request`] with its `authorization` replaced.
pub fn with_authorization(mut request: Value, authorization: Value) -> Value {
    request["authorization"] = authorization;
    request
}

/// [`request`] to another host.
pub fn to_host(mut request: Value, host: &str) -> Value {
    request["host"] = json!(host);
    request
}

pub struct RunOptions<'a> {
    pub upstream: Option<&'a Upstream>,
    pub requests: Vec<Value>,
    /// Hold the child after it has recorded itself, until the test says go.
    pub wait: bool,
    /// Keep the child alive this long after its last request.
    pub linger_ms: u64,
    pub passphrase: &'a str,
}

impl<'a> RunOptions<'a> {
    pub fn new(upstream: Option<&'a Upstream>, requests: Vec<Value>) -> Self {
        Self {
            upstream,
            requests,
            wait: false,
            linger_ms: 0,
            passphrase: STORE_PASSPHRASE,
        }
    }
}

pub struct Running<'a> {
    sandbox: &'a Sandbox,
    child: Child,
    pub out: PathBuf,
}

pub struct Finished {
    pub output: Output,
    pub out: PathBuf,
}

impl Sandbox {
    /// Start `dev run --agent` with the child and plan of `options`.
    pub fn spawn_run(&self, options: &RunOptions<'_>) -> Running<'_> {
        static RUNS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let out = self.path("out").join(format!("run-{n}"));
        std::fs::create_dir_all(&out).unwrap();
        let script = self.path("child.mjs");
        std::fs::write(&script, CHILD_SCRIPT).unwrap();
        let plan = json!({
            "wait": options.wait,
            "lingerMs": options.linger_ms,
            "requests": options.requests,
        });
        std::fs::write(out.join("plan.json"), plan.to_string()).unwrap();

        let mut command = self.command();
        command
            .args(["dev", "--agent", "run", "--", "sh", "-c"])
            .arg("exec node \"$0\" \"$1\" --token \"$VERCEL_TOKEN\"")
            .arg(&script)
            .arg(&out)
            .env("OPENSESAME_STORE_PASSWORD", options.passphrase)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(upstream) = options.upstream {
            let ca = self.path("upstream-ca.pem");
            std::fs::write(&ca, upstream.ca.ca_pem()).unwrap();
            command.env(OVERRIDE_ENV, upstream.override_value(HOST, &ca));
        }
        Running {
            sandbox: self,
            child: command.spawn().unwrap(),
            out,
        }
    }

    /// [`Sandbox::spawn_run`] to the end.
    pub fn run(&self, options: &RunOptions<'_>) -> Finished {
        self.spawn_run(options).finish()
    }
}

impl Running<'_> {
    /// Block until the child has recorded itself and is holding. Fails if the
    /// run ended first, with what it said.
    pub fn wait_ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !self.out.join("ready").exists() {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.ended_before_ready(status);
            }
            assert!(Instant::now() < deadline, "the child never became ready");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn ended_before_ready(&mut self, status: ExitStatus) -> ! {
        let mut stderr = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            std::io::Read::read_to_string(&mut pipe, &mut stderr).unwrap();
        }
        panic!("the run ended ({status}) before its child was ready: {stderr}");
    }

    /// What the child recorded of its environment.
    pub fn env(&self) -> BTreeMap<String, String> {
        child_env(&self.out)
    }

    /// Let a held child go on to its requests.
    pub fn go(&self) {
        std::fs::write(self.out.join("go"), "").unwrap();
    }

    pub fn finish(self) -> Finished {
        let Self {
            sandbox,
            child,
            out,
        } = self;
        let output = child.wait_with_output().unwrap();
        sandbox.keep(&format!("dev run ({})", display(&out)), &output);
        Finished { output, out }
    }
}

fn child_env(out: &std::path::Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(out.join("env.txt"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

impl Finished {
    pub fn code(&self) -> Option<i32> {
        self.output.status.code()
    }

    pub fn stdout(&self) -> String {
        String::from_utf8_lossy(&self.output.stdout).into_owned()
    }

    pub fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.output.stderr).into_owned()
    }

    /// Whether the child ran at all.
    pub fn child_ran(&self) -> bool {
        self.out.join("env.txt").exists()
    }

    pub fn env(&self) -> BTreeMap<String, String> {
        child_env(&self.out)
    }

    pub fn argv(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.out.join("argv.json")).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or_default()
    }

    /// What the child got back for each request it made, in order.
    pub fn results(&self) -> Vec<Value> {
        std::fs::read_to_string(self.out.join("results.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// `127.0.0.1:port` of the run's proxy, from the child's `HTTPS_PROXY`.
    pub fn proxy_addr(&self) -> Option<String> {
        let proxy = self.env().get("HTTPS_PROXY")?.clone();
        let (_, addr) = proxy.rsplit_once('@')?;
        Some(addr.trim_end_matches('/').to_owned())
    }
}
