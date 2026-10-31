//! One loopback HTTP response, including intentionally incomplete framing.
#![allow(
    dead_code,
    reason = "shared fixture; each integration binary uses a different subset"
)]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Copy)]
pub enum Framing {
    Length(u64),
    Chunked,
    Close,
    ChunkedWithLength(u64),
    InvalidLength,
}

pub struct Stub {
    pub base: String,
    pub connections: Arc<AtomicUsize>,
    pub target: Arc<Mutex<Option<String>>>,
    pub authorization: Arc<AtomicBool>,
    pub cookie: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn spawn(status: u16, framing: Framing, body: Vec<u8>, hold_open: bool) -> Stub {
    spawn_response(status, framing, body, hold_open, None).await
}

pub async fn redirect(location: &str) -> Stub {
    spawn_response(
        302,
        Framing::Length(0),
        Vec::new(),
        false,
        Some(location.to_owned()),
    )
    .await
}

async fn spawn_response(
    status: u16,
    framing: Framing,
    body: Vec<u8>,
    hold_open: bool,
    location: Option<String>,
) -> Stub {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let connections = Arc::new(AtomicUsize::new(0));
    let accepted = Arc::clone(&connections);
    let target = Arc::new(Mutex::new(None));
    let received_target = Arc::clone(&target);
    let authorization = Arc::new(AtomicBool::new(false));
    let received_authorization = Arc::clone(&authorization);
    let cookie = Arc::new(AtomicBool::new(false));
    let received_cookie = Arc::clone(&cookie);
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        accepted.fetch_add(1, Ordering::SeqCst);
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|part| part == b"\r\n\r\n") {
            let n = stream.read(&mut buffer).await.unwrap();
            if n == 0 || request.len() + n > 16 * 1024 {
                return;
            }
            request.extend_from_slice(&buffer[..n]);
        }
        let request = String::from_utf8_lossy(&request);
        received_authorization.store(has_header(&request, "authorization"), Ordering::SeqCst);
        received_cookie.store(has_header(&request, "cookie"), Ordering::SeqCst);
        *received_target.lock().unwrap() = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .map(str::to_owned);
        let header = match framing {
            Framing::Length(length) => format!("Content-Length: {length}\r\n"),
            Framing::Chunked => "Transfer-Encoding: chunked\r\n".into(),
            Framing::Close => String::new(),
            Framing::ChunkedWithLength(length) => {
                format!("Transfer-Encoding: chunked\r\nContent-Length: {length}\r\n")
            }
            Framing::InvalidLength => "Content-Length: not-a-number\r\n".into(),
        };
        let location = location
            .map(|value| format!("Location: {value}\r\n"))
            .unwrap_or_default();
        let head = format!("HTTP/1.1 {status} test\r\nConnection: close\r\nSet-Cookie: fixture=opaque; Path=/\r\n{location}{header}\r\n");
        if stream.write_all(head.as_bytes()).await.is_err() {
            return;
        }
        if write_body(&mut stream, framing, &body, hold_open)
            .await
            .is_err()
        {
            return;
        }
        if hold_open {
            std::future::pending::<()>().await;
        }
    });
    Stub {
        base,
        connections,
        target,
        authorization,
        cookie,
        task,
    }
}

fn has_header(request: &str, name: &str) -> bool {
    request
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .any(|(field, _)| field.eq_ignore_ascii_case(name))
}

async fn write_body(
    stream: &mut tokio::net::TcpStream,
    framing: Framing,
    body: &[u8],
    hold_open: bool,
) -> std::io::Result<()> {
    if matches!(framing, Framing::Chunked | Framing::ChunkedWithLength(_)) {
        for chunk in body.chunks(8192) {
            let length = format!("{:x}\r\n", chunk.len());
            stream.write_all(length.as_bytes()).await?;
            stream.write_all(chunk).await?;
            stream.write_all(b"\r\n").await?;
        }
        if !hold_open {
            stream.write_all(b"0\r\n\r\n").await?;
        }
    } else {
        stream.write_all(body).await?;
    }
    Ok(())
}
