//! Loopback stub that approves CLI app-integration ensure calls (journey tests).

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, OnceLock};
use std::thread;

use base64::Engine as _;
use ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::elliptic_curve::Generate;
use p256::PublicKey;

const ENSURE_PATH: &str = "/v1/cli/app-integration/ensure";
const HEALTH_PATH: &str = "/health";
const DAEMON_ATTEST_PATH: &str = "/v1/cli/app-integration/daemon-attest";
const PIN_PROBE_VERB: &str = "daemon-pin-probe";

struct TestDaemonPin {
    signing_key: SigningKey,
    public_key_spki_b64: String,
}

static TEST_DAEMON_PIN: OnceLock<TestDaemonPin> = OnceLock::new();

fn test_daemon_pin() -> &'static TestDaemonPin {
    TEST_DAEMON_PIN.get_or_init(|| {
        let signing_key = SigningKey::generate();
        let public_key = PublicKey::from(signing_key.verifying_key());
        let der = public_key
            .to_public_key_der()
            .expect("test daemon pin public key encodes");
        let public_key_spki_b64 =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(der.as_ref());
        TestDaemonPin {
            signing_key,
            public_key_spki_b64,
        }
    })
}

/// SPKI the CLI reads from `OPENSESAME_CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_SPKI_B64`.
pub fn daemon_pin_public_key_spki_b64() -> &'static str {
    &test_daemon_pin().public_key_spki_b64
}

const DAEMON_ATTEST_LABEL: &[u8] = b"opensesame-cli-app-daemon-attest.v1";

fn daemon_attest_message(nonce: &str) -> Vec<u8> {
    let mut msg = Vec::from(DAEMON_ATTEST_LABEL);
    msg.push(0);
    msg.extend_from_slice(nonce.as_bytes());
    msg
}

fn sign_daemon_attest_nonce(nonce: &str) -> String {
    let message = daemon_attest_message(nonce);
    let sig: p256::ecdsa::Signature = test_daemon_pin().signing_key.sign(&message);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

fn read_request(stream: &mut TcpStream) -> Option<(String, String, String)> {
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
    let length: usize = head
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())
        })
        .flatten()
        .unwrap_or(0);
    while body.len() < length {
        let n = stream.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    let mut first = head.lines().next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let path = first.next().unwrap_or_default().to_string();
    let body_text = String::from_utf8_lossy(&body[..length.min(body.len())]).into_owned();
    Some((method, path, body_text))
}

fn ensure_verb_is(body: &str, expected: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    value.get("verb").and_then(|v| v.as_str()) == Some(expected)
}

fn attest_nonce(body: &str) -> Option<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return None;
    };
    value
        .get("nonce")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn handle(mut stream: TcpStream) {
    let Some((method, path, body)) = read_request(&mut stream) else {
        return;
    };
    let (status, reply) = if method == "GET" && path == HEALTH_PATH {
        ("200 OK", r#"{"status":"ok"}"#.to_string())
    } else if method == "POST" && path == ENSURE_PATH {
        if ensure_verb_is(&body, PIN_PROBE_VERB) {
            ("200 OK", r#"{"status":"pending"}"#.to_string())
        } else {
            ("200 OK", r#"{"status":"approved"}"#.to_string())
        }
    } else if method == "POST" && path == DAEMON_ATTEST_PATH {
        let nonce = attest_nonce(&body).unwrap_or_default();
        let signature_b64 = sign_daemon_attest_nonce(&nonce);
        let reply = serde_json::json!({ "signatureB64": signature_b64 }).to_string();
        ("200 OK", reply)
    } else {
        ("404 Not Found", "{}".to_string())
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
        reply.len()
    );
}

/// Returns a base URL such as `http://127.0.0.1:PORT`.
pub fn serve_always_approve() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else {
                return;
            };
            thread::spawn(move || handle(stream));
        }
    });
    url
}

/// Loopback mock daemon plus pin SPKI for journey subprocesses.
pub fn apply_journey_daemon_env(command: &mut std::process::Command) {
    command
        .env("OPENSESAME_DAEMON_API", shared_daemon_base().as_str())
        .env(
            "OPENSESAME_CLI_APP_INTEGRATION_DAEMON_PIN_PUBLIC_KEY_SPKI_B64",
            daemon_pin_public_key_spki_b64(),
        );
}

/// One shared daemon for the whole binary.
pub fn shared_daemon_base() -> Arc<String> {
    static ONCE: OnceLock<Arc<String>> = OnceLock::new();
    Arc::clone(ONCE.get_or_init(|| Arc::new(serve_always_approve())))
}
