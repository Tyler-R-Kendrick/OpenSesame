//! A loopback HTTPS login site: `GET /login` serves the form, `POST /session`
//! signs in and — as a careless site does — echoes what it was sent, in the
//! body and in a header. It records every request whole, so a test can say
//! exactly what crossed the wire and how often.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use opensesame_transport_security::testkit::DisposableCa;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use secrecy::ExposeSecret;

/// One request the site received.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    /// Every header, `name: value`.
    pub headers: Vec<String>,
    pub body: String,
}

impl Seen {
    /// The whole request as text, for "appears anywhere" assertions.
    pub fn text(&self) -> String {
        format!(
            "{} {}\n{}\n\n{}",
            self.method,
            self.path,
            self.headers.join("\n"),
            self.body
        )
    }
}

pub struct LoginSite {
    pub host: &'static str,
    pub addr: SocketAddr,
    pub ca: DisposableCa,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl LoginSite {
    pub fn origin(&self) -> String {
        format!("https://{}:{}", self.host, self.addr.port())
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    pub fn ca_pem(&self) -> String {
        String::from_utf8(self.ca.ca_pem()).unwrap()
    }
}

/// `application/x-www-form-urlencoded` decoded, `+` as a space.
pub fn form_field(body: &str, name: &str) -> Option<String> {
    body.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (decode(key) == name).then(|| decode(value))
    })
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => out.push(b' '),
            b'%' if at + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).unwrap_or("zz");
                out.push(u8::from_str_radix(hex, 16).unwrap_or(b'?'));
                at += 2;
            }
            byte => out.push(byte),
        }
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn server_config(ca: &DisposableCa, host: &str) -> rustls::ServerConfig {
    let leaf = ca.issue_server(host);
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&leaf.cert_pem)
        .map(|cert| cert.expect("cert"))
        .collect();
    let key = PrivateKeyDer::from_pem_slice(leaf.key_pem.expose_secret()).expect("key");
    rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .expect("server config")
}

fn respond(seen: &Seen) -> Response<Full<Bytes>> {
    let html = |body: String| {
        Response::builder()
            .header("content-type", "text/html; charset=utf-8")
            .body(Full::new(Bytes::from(body)))
            .unwrap()
    };
    match (seen.method.as_str(), seen.path.as_str()) {
        ("GET", "/login") => html(
            "<form method=post action=/session><input name=username>\
             <input type=password name=password></form>"
                .into(),
        ),
        ("POST", "/session") => {
            let password = form_field(&seen.body, "password").unwrap_or_default();
            Response::builder()
                .header("content-type", "text/html; charset=utf-8")
                .header("set-cookie", "sid=signed-in; Secure; HttpOnly")
                .header("x-debug-password", password.clone())
                .body(Full::new(Bytes::from(format!(
                    "<p>welcome back; you sent password {password} and form {}</p>",
                    seen.body
                ))))
                .unwrap()
        }
        _ => Response::builder()
            .status(404)
            .body(Full::new(Bytes::new()))
            .unwrap(),
    }
}

async fn serve_one(
    stream: tokio::net::TcpStream,
    acceptor: tokio_rustls::TlsAcceptor,
    seen: Arc<Mutex<Vec<Seen>>>,
) {
    let Ok(tls) = acceptor.accept(stream).await else {
        return;
    };
    let service = service_fn(move |req: Request<Incoming>| {
        let seen = Arc::clone(&seen);
        async move {
            let (parts, body) = req.into_parts();
            let body = body
                .collect()
                .await
                .map(http_body_util::Collected::to_bytes)
                .unwrap_or_default();
            let request = Seen {
                method: parts.method.to_string(),
                path: parts.uri.path().to_owned(),
                headers: parts
                    .headers
                    .iter()
                    .map(|(n, v)| format!("{n}: {}", String::from_utf8_lossy(v.as_bytes())))
                    .collect(),
                body: String::from_utf8_lossy(&body).into_owned(),
            };
            let response = respond(&request);
            seen.lock().unwrap().push(request);
            Ok::<_, std::convert::Infallible>(response)
        }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(tls), service)
        .await;
}

/// A login site for `localhost` on 127.0.0.1, under its own CA.
pub async fn spawn_login_site() -> LoginSite {
    let host = "localhost";
    let ca = DisposableCa::new("login site");
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config(&ca, host)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let task_seen = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_one(stream, acceptor.clone(), Arc::clone(&task_seen)));
        }
    });
    LoginSite {
        host,
        addr,
        ca,
        seen,
    }
}
