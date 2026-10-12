//! Loopback HTTP POST for CLI app-integration (no async runtime).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// POST JSON to `http://127.0.0.1:port/path` and return status code plus body.
pub fn post_json_loopback(
    base: &str,
    path: &str,
    json_body: &str,
) -> Result<(u16, String), ()> {
    let base = base.trim_end_matches('/');
    let path = if path.starts_with('/') {
        path
    } else {
        return Err(());
    };
    let without_scheme = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"))
        .ok_or(())?;
    if base.starts_with("https://") {
        return Err(());
    }
    let (host, port) = match without_scheme.split_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().map_err(|_| ())?),
        None => (without_scheme, 80),
    };
    if host != "127.0.0.1" && host != "localhost" {
        return Err(());
    }
    let mut stream = TcpStream::connect((host, port)).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| ())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| ())?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nhost: {host}:{port}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        json_body.len(),
        json_body
    );
    stream.write_all(request.as_bytes()).map_err(|_| ())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|_| ())?;
    let text = String::from_utf8(raw).map_err(|_| ())?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next().ok_or(())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or(())?;
    let mut body = String::new();
    let mut in_body = false;
    let mut content_length: Option<usize> = None;
    for line in lines {
        if !in_body {
            if line.is_empty() {
                in_body = true;
                continue;
            }
            if let Some((key, value)) = line.split_once(':') {
                if key.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().ok();
                }
            }
            continue;
        }
        if body.is_empty() {
            body = line.to_string();
        } else {
            body.push_str("\r\n");
            body.push_str(line);
        }
        if let Some(len) = content_length {
            if body.len() >= len {
                body.truncate(len);
                break;
            }
        }
    }
    Ok((status, body))
}
