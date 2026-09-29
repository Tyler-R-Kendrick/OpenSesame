//! The child side: an unmodified HTTPS client that knows only what its
//! environment told it — the proxy URL, the run CA, and a surrogate.

use std::net::SocketAddr;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::header::HeaderMap;
use hyper::Request;
use hyper_util::rt::TokioIo;
use opensesame_surrogate_proxy::RunHandle;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use secrecy::ExposeSecret;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::stub::client_trusting;

/// A response as the child sees it.
#[derive(Debug)]
pub struct Seen {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
}

/// `Basic base64(user:secret)` from the run's proxy URL.
pub fn proxy_authorization(handle: &RunHandle) -> String {
    let url = handle.proxy_url().expose_secret();
    let userinfo = url
        .trim_start_matches("http://")
        .split_once('@')
        .expect("credential in the proxy url")
        .0;
    format!("Basic {}", STANDARD.encode(userinfo))
}

/// A TLS client config that trusts exactly the run CA, as the child's trust
/// variables arrange.
pub fn run_trust(handle: &RunHandle) -> rustls::ClientConfig {
    let der = CertificateDer::from_pem_slice(handle.ca_pem().as_bytes()).expect("ca pem");
    client_trusting(&der)
}

/// Send raw bytes to the proxy and read the response head. Returns the status
/// and the still-open stream.
pub async fn raw_request(proxy: SocketAddr, head: &str) -> (u16, TcpStream) {
    let mut stream = TcpStream::connect(proxy).await.expect("proxy reachable");
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut byte = [0_u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
            break;
        }
        buf.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&buf);
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    (status, stream)
}

/// `CONNECT authority` with the given `Proxy-Authorization`.
pub async fn connect(
    proxy: SocketAddr,
    authority: &str,
    proxy_auth: Option<&str>,
) -> (u16, TcpStream) {
    let auth = proxy_auth.map_or(String::new(), |value| {
        format!("Proxy-Authorization: {value}\r\n")
    });
    raw_request(
        proxy,
        &format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{auth}\r\n"),
    )
    .await
}

/// TLS over an established tunnel, with `sni` as the server name.
pub async fn tls(
    stream: TcpStream,
    config: rustls::ClientConfig,
    sni: &str,
) -> std::io::Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let mut config = config;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let name = ServerName::try_from(sni.to_owned()).expect("server name");
    connector.connect(name, stream).await
}

/// One HTTP/1.1 request over any stream.
pub async fn send<S>(stream: S, request: Request<Full<Bytes>>) -> Option<Seen>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .ok()?;
    tokio::spawn(conn);
    let response = sender.send_request(request).await.ok()?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.ok()?.to_bytes();
    Some(Seen {
        status,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// A request as an SDK would build it: `Host`, then the given headers.
pub fn request(
    method: &str,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> Request<Full<Bytes>> {
    body_request(method, host, path, headers, Bytes::new())
}

pub fn body_request(
    method: &str,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Bytes,
) -> Request<Full<Bytes>> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", host);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Full::new(body)).unwrap()
}

/// The whole road: CONNECT `host:443`, TLS as `host` trusting the run CA,
/// then `request`. `None` when the tunnel or the handshake was refused.
pub async fn through_proxy(
    handle: &RunHandle,
    host: &str,
    request: Request<Full<Bytes>>,
) -> Option<Seen> {
    let auth = proxy_authorization(handle);
    let (status, stream) = connect(handle.proxy_addr(), &format!("{host}:443"), Some(&auth)).await;
    if status != 200 {
        return None;
    }
    let tls = tls(stream, run_trust(handle), host).await.ok()?;
    send(tls, request).await
}

/// `Authorization: Bearer <surrogate>` for the run's first grant.
pub fn bearer(handle: &RunHandle) -> String {
    format!("Bearer {}", handle.surrogates()[0].1.as_str())
}
