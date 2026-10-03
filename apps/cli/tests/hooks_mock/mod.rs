//! Stand-in servers and a way to run the real binary, shared by the hooks CLI
//! tests that talk to a Host or an Identity API (ADR 0150): every connection
//! on its own thread, answered by a closure, every request logged.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::Value;

pub const HANDLE: &str = "inbox_YXBwcm92ZXI.test-tag";
pub const BEARER: &str = "requester-bearer-for-the-cli-tests";

pub fn opensesame(config: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env("XDG_CONFIG_HOME", config)
        .env("HOME", config)
        .env_remove("OPENSESAME_OPERATOR_TOKEN")
        .env_remove("OPENSESAME_HOOK_POLICY")
        .env_remove("OPENSESAME_HOOK_APPROVER_URL")
        .env_remove("OPENSESAME_HOOK_APPROVER_REF")
        .env_remove("OPENSESAME_HOOK_APPROVER_BEARER")
        .env_remove("OPENSESAME_HOOK_APPROVER_TIMEOUT_SECONDS");
    command
}

pub fn stdout_json(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("stdout is JSON")
}

/// One raw request: method, path, the headers that matter, the body.
#[derive(Clone, Debug, Default)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub authorization: String,
    pub if_match: String,
    pub body: String,
}

fn header_of(head: &str, name: &str) -> String {
    head.lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
        .unwrap_or_default()
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let split = loop {
        let n = stream.read(&mut buf).unwrap_or(0);
        if n == 0 {
            return None;
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
    };
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut body = raw[split + 4..].to_vec();
    let length: usize = header_of(&head, "content-length").parse().unwrap_or(0);
    while body.len() < length {
        let n = stream.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    let mut first = head.lines().next().unwrap_or_default().split(' ');
    Some(Request {
        method: first.next().unwrap_or_default().to_owned(),
        path: first.next().unwrap_or_default().to_owned(),
        authorization: header_of(&head, "authorization"),
        if_match: header_of(&head, "if-match"),
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

pub type Answer = dyn Fn(&Request, &[Request]) -> (&'static str, Value) + Send + Sync;

/// One connection: read the request, answer it, log it.
fn handle(mut stream: TcpStream, log: &Mutex<Vec<Request>>, answer: &Answer) {
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    let (status, reply) = {
        let mut log = log.lock().unwrap();
        let reply = answer(&request, &log);
        log.push(request);
        reply
    };
    let reply = reply.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
        reply.len()
    );
}

/// Serve every connection on its own thread with `answer`, logging requests.
pub fn serve(
    answer: impl Fn(&Request, &[Request]) -> (&'static str, Value) + Send + Sync + 'static,
) -> (String, Arc<Mutex<Vec<Request>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let answer: Arc<Answer> = Arc::new(answer);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let (log, answer) = (Arc::clone(&log), Arc::clone(&answer));
            thread::spawn(move || handle(stream, &log, answer.as_ref()));
        }
    });
    (url, seen)
}
