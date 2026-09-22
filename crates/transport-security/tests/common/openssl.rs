//! The `openssl s_client` oracle: an independent TLS implementation driven
//! against the listener, used by `tests/openssl_oracle.rs`.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

/// Run `openssl s_client` against `addr` with `extra` arguments, feeding a
/// `GET /health` request, and return combined stdout+stderr (prefixed
/// `exit=<code> timeout=<bool>`). The child MUST be driven on a blocking
/// thread: the test runtime is single-threaded, so a test body that blocks on
/// it starves the listener task, the TCP connect still succeeds through the
/// kernel backlog, the handshake is never serviced, and `s_client` prints
/// `CONNECTED` and nothing else.
pub async fn openssl_s_client(addr: SocketAddr, extra: &[&str]) -> String {
    let extra: Vec<String> = extra.iter().map(|s| (*s).to_string()).collect();
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = extra.iter().map(String::as_str).collect();
        openssl_s_client_blocking(addr, &refs)
    })
    .await
    .expect("openssl driver thread")
}

/// Copy everything a child pipe produces into `sink` until it closes.
fn pump(pipe: &mut dyn std::io::Read, sink: &std::sync::Mutex<String>) {
    let mut buf = [0u8; 4096];
    while let Ok(n) = pipe.read(&mut buf) {
        if n == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
        sink.lock().unwrap().push_str(&text);
    }
}

/// Blocking body of [`openssl_s_client`]: line-buffered through `stdbuf` so
/// a killed child still leaves its output behind. stdin stays open until the
/// HTTP response has been seen, the child has exited, or ten seconds pass;
/// then stdin closes (which ends `s_client`) and a child still alive after
/// that is killed.
fn openssl_s_client_blocking(addr: SocketAddr, extra: &[&str]) -> String {
    use std::io::{Read, Write};
    use std::sync::Mutex;
    let openssl = std::path::Path::new("/usr/bin/openssl");
    assert!(
        openssl.exists(),
        "openssl oracle missing at /usr/bin/openssl"
    );
    let mut cmd = std::process::Command::new("/usr/bin/stdbuf");
    cmd.arg("-oL")
        .arg("-eL")
        .arg(openssl)
        .arg("s_client")
        .arg("-connect")
        .arg(addr.to_string())
        .arg("-servername")
        .arg("localhost")
        .args(extra)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().expect("spawn openssl");
    let collected = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    for mut pipe in [
        Box::new(child.stdout.take().expect("stdout")) as Box<dyn Read + Send>,
        Box::new(child.stderr.take().expect("stderr")) as Box<dyn Read + Send>,
    ] {
        let sink = Arc::clone(&collected);
        readers.push(std::thread::spawn(move || pump(pipe.as_mut(), &sink)));
    }
    let mut stdin = child.stdin.take().expect("stdin");
    let _ =
        stdin.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    let _ = stdin.flush();
    let started = std::time::Instant::now();
    let mut timed_out = false;
    loop {
        if child.try_wait().expect("try_wait").is_some() {
            break;
        }
        let seen_response = collected.lock().unwrap().contains("\r\n\r\nok");
        if seen_response {
            break;
        }
        if started.elapsed() > Duration::from_secs(10) {
            timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(stdin);
    let closed = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break Some(status);
        }
        if closed.elapsed() > Duration::from_secs(3) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    for reader in readers {
        let _ = reader.join();
    }
    let output = collected.lock().unwrap().clone();
    format!(
        "exit={:?} timeout={timed_out}\n{output}",
        status.and_then(|s| s.code())
    )
}
