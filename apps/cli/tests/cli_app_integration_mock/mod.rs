//! Loopback stub that approves CLI app-integration ensure calls (journey tests).

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

const ENSURE_PATH: &str = "/v1/cli/app-integration/ensure";

fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
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
    Some((method, path))
}

fn handle(mut stream: TcpStream) {
    let Some((method, path)) = read_request(&mut stream) else {
        return;
    };
    let (status, reply) = if method == "POST" && path == ENSURE_PATH {
        ("200 OK", r#"{"status":"approved"}"#)
    } else {
        ("404 Not Found", "{}")
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

/// One shared daemon for the whole test binary.
pub fn shared_daemon_base() -> Arc<String> {
    static ONCE: std::sync::OnceLock<Arc<String>> = std::sync::OnceLock::new();
    Arc::clone(ONCE.get_or_init(|| Arc::new(serve_always_approve())))
}
