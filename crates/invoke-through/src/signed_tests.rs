//! Signed execution: what the signer sees is what is sent, and a rule's auth
//! style decides which executor may present a credential to its hosts.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use secrecy::SecretString;

use super::*;
use crate::egress::{AuthStyle, EgressRule};
use crate::invoke::{InvokeRequest, Invoker};

const SECRET: &str = "vtok_dummy_marker_0123456789abcdef";

/// What the signer was shown: method, URI, headers, body.
type Shown = (String, String, Vec<(String, String)>, Vec<u8>);

struct RecordingSigner {
    secret: SecretString,
    seen: Mutex<Vec<Shown>>,
}

impl RecordingSigner {
    fn new() -> Self {
        Self {
            secret: SecretString::from(SECRET),
            seen: Mutex::new(Vec::new()),
        }
    }
}

impl RequestSigner for RecordingSigner {
    fn sign(&self, parts: &SignableParts<'_>) -> Result<Vec<(String, String)>, InvokeError> {
        self.seen.lock().unwrap().push((
            parts.method.to_string(),
            parts.uri.clone(),
            parts
                .headers
                .iter()
                .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
                .collect(),
            parts.body.to_vec(),
        ));
        Ok(vec![
            (
                "authorization".into(),
                "AWS4-HMAC-SHA256 Signature=fixture".into(),
            ),
            ("x-amz-date".into(), "20261017T000000Z".into()),
        ])
    }

    fn reflection_secrets(&self) -> Vec<&SecretString> {
        vec![&self.secret]
    }
}

fn rule(auth: AuthStyle) -> EgressRule {
    EgressRule {
        provider_id: "aws-sts",
        scheme: "https",
        hosts: &["127.0.0.1"],
        auth,
    }
}

fn post(url: String) -> InvokeRequest {
    InvokeRequest {
        provider_id: "aws-sts".into(),
        method: "POST".into(),
        url,
        headers: vec![(
            "content-type".into(),
            "application/x-www-form-urlencoded; charset=utf-8".into(),
        )],
        body: Some(Bytes::from_static(b"Action=AssumeRole&Version=2011-06-15")),
        subject: None,
        actor: None,
    }
}

type Seen = Arc<Mutex<Vec<Vec<(String, String)>>>>;

async fn recording_stub(body: &'static str) -> (String, Seen) {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let task = seen.clone();
    let (base, _) = crate::invoke::stub::spawn_stub(move |req| {
        task.lock().unwrap().push(
            req.headers()
                .iter()
                .map(|(name, value)| {
                    (
                        name.as_str().to_string(),
                        value.to_str().unwrap_or("").to_string(),
                    )
                })
                .collect(),
        );
        (200, vec![("content-type", "text/xml")], body)
    })
    .await;
    (base, seen)
}

#[tokio::test]
async fn the_signer_covers_exactly_what_is_sent() {
    let (base, wire) = recording_stub("<ok/>").await;
    let invoker = Invoker::with_rules(vec![rule(AuthStyle::SigV4)]).allow_http_for_tests();
    let signer = RecordingSigner::new();
    let prepared = invoker.preflight(post(format!("{base}/"))).unwrap();
    let response = invoker.execute_signed(&signer, prepared).await.unwrap();
    assert_eq!(response.status, 200);

    let shown = signer.seen.lock().unwrap().clone();
    assert_eq!(shown.len(), 1);
    let (method, uri, headers, body) = &shown[0];
    assert_eq!(method, "POST");
    assert_eq!(uri, &format!("{base}/"));
    assert_eq!(body, b"Action=AssumeRole&Version=2011-06-15");

    let sent = wire.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    // Every header the signer was shown went out unchanged...
    for (name, value) in headers {
        assert!(
            sent[0].iter().any(|(n, v)| n == name && v == value),
            "{name} was signed but not sent as signed"
        );
    }
    // ...and the signer's own headers were added.
    assert!(sent[0]
        .iter()
        .any(|(n, v)| n == "authorization" && v.starts_with("AWS4-HMAC-SHA256")));
    assert!(sent[0].iter().any(|(n, _)| n == "x-amz-date"));
}

#[tokio::test]
async fn a_bearer_rule_is_never_signed_and_a_signed_rule_never_bears() {
    let (base, wire) = recording_stub("<ok/>").await;
    let bearer = Invoker::with_rules(vec![rule(AuthStyle::Bearer)]).allow_http_for_tests();
    let prepared = bearer.preflight(post(format!("{base}/"))).unwrap();
    let refused = bearer
        .execute_signed(&RecordingSigner::new(), prepared)
        .await
        .unwrap_err();
    assert!(
        matches!(refused, InvokeError::UnsupportedProvider(_)),
        "{refused:?}"
    );

    let signed = Invoker::with_rules(vec![rule(AuthStyle::SigV4)]).allow_http_for_tests();
    let prepared = signed.preflight(post(format!("{base}/"))).unwrap();
    let refused = signed
        .execute(&SecretString::from(SECRET), prepared)
        .await
        .unwrap_err();
    assert!(
        matches!(refused, InvokeError::UnsupportedProvider(_)),
        "{refused:?}"
    );
    assert!(
        wire.lock().unwrap().is_empty(),
        "nothing may reach the wire"
    );
}

#[tokio::test]
async fn a_reflected_secret_is_scrubbed_from_a_signed_answer() {
    let (base, _) = recording_stub("echo vtok_dummy_marker_0123456789abcdef").await;
    let invoker = Invoker::with_rules(vec![rule(AuthStyle::SigV4)]).allow_http_for_tests();
    let prepared = invoker.preflight(post(format!("{base}/"))).unwrap();
    let response = invoker
        .execute_signed(&RecordingSigner::new(), prepared)
        .await
        .unwrap();
    let body = String::from_utf8(response.body.to_vec()).unwrap();
    assert!(!body.contains(SECRET), "{body}");
    assert!(response.receipt.credential_reflected);
}
