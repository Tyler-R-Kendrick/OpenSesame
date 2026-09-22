//! Loopback HTTP stub shared by the invoke-through unit tests: records
//! `(path, authorization)` per hit, which is how the egress tests prove the
//! wire was never touched.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::Full;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;

pub(crate) struct Recorded {
    pub(crate) hits: Vec<(String, Option<String>)>,
}

/// The stub's response for one request: status, headers, body.
pub(crate) type StubResponse = (u16, Vec<(&'static str, &'static str)>, &'static str);

#[expect(
    clippy::excessive_nesting,
    reason = "the nested tasks model the loopback server's connection and request lifetimes"
)]
pub(crate) async fn spawn_stub(
    responder: impl Fn(&hyper::Request<hyper::body::Incoming>) -> StubResponse + Send + Sync + 'static,
) -> (String, Arc<Mutex<Recorded>>) {
    let recorded = Arc::new(Mutex::new(Recorded { hits: vec![] }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let recorded_task = recorded.clone();
    let responder = Arc::new(responder);
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let io = TokioIo::new(stream);
            let recorded = recorded_task.clone();
            let responder = responder.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req| {
                    let recorded = recorded.clone();
                    let responder = responder.clone();
                    async move {
                        let auth = req
                            .headers()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_string);
                        let target = req.uri().path().to_string();
                        recorded.lock().unwrap().hits.push((target, auth));
                        let (status, headers, body) = responder(&req);
                        let mut response = hyper::Response::builder().status(status);
                        for (name, value) in headers {
                            response = response.header(name, value);
                        }
                        Ok::<_, std::convert::Infallible>(
                            response.body(Full::new(Bytes::from(body))).unwrap(),
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, service)
                    .await;
            });
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), recorded)
}
