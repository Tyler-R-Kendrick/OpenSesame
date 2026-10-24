//! The signer never lets `aws-sigv4`'s trace output — which includes the
//! canonical request and with it `x-amz-security-token` — reach a subscriber.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Metadata, Subscriber};

use super::*;

const SECRET: &str = "vtok_dummy_marker_0123456789abcdef";
const TOKEN: &str = "vtok_dummy_marker_session_0123456789";

/// Records every field of every event, at every level.
#[derive(Clone, Default)]
struct Everything(Arc<Mutex<String>>);

struct Fields<'a>(&'a mut String);

impl Visit for Fields<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let _ = write!(self.0, " {}={value:?}", field.name());
    }
}

impl Subscriber for Everything {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let mut seen = self.0.lock().unwrap();
        let _ = write!(seen, "\n{}", event.metadata().target());
        event.record(&mut Fields(&mut seen));
    }
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
}

fn sign_once() -> Vec<(String, String)> {
    let signer = SigV4Signer::new(
        SourceCredential::new(
            "AKIAVTOKDUMMYMARKER0",
            SecretString::from(SECRET),
            Some(SecretString::from(TOKEN)),
        ),
        "us-east-1",
    );
    signer
        .sign(&SignableParts {
            method: "POST",
            uri: "https://sts.us-east-1.amazonaws.com/".into(),
            headers: vec![("content-type", "application/x-www-form-urlencoded")],
            body: b"Action=AssumeRole",
        })
        .expect("signed")
}

#[test]
fn signing_emits_nothing_to_any_subscriber() {
    let everything = Everything::default();
    let added = tracing::subscriber::with_default(everything.clone(), sign_once);
    let seen = everything.0.lock().unwrap().clone();
    assert!(seen.is_empty(), "the signer leaked trace output: {seen}");
    assert!(added.iter().any(|(name, _)| name == "authorization"));
    assert!(added
        .iter()
        .any(|(name, value)| name == "x-amz-security-token" && value == TOKEN));
    for (_, value) in &added {
        assert!(!value.contains(SECRET), "the secret key is in a header");
    }
}

#[test]
fn a_credential_prints_nothing_secret() {
    let credential = SourceCredential::new(
        "AKIAVTOKDUMMYMARKER0",
        SecretString::from(SECRET),
        Some(SecretString::from(TOKEN)),
    );
    let alone = format!("{credential:?}");
    let shown = format!("{alone} {:?}", SigV4Signer::new(credential, "us-east-1"));
    for leaked in ["AKIAVTOKDUMMYMARKER0", SECRET, TOKEN] {
        assert!(!shown.contains(leaked), "{leaked} in {shown}");
    }
}

#[test]
fn a_configuration_without_both_keys_is_no_credential() {
    let pair = |id: &str, secret: &str| {
        std::collections::BTreeMap::from([
            ("access_key_id".to_string(), id.to_string()),
            ("secret_access_key".to_string(), secret.to_string()),
        ])
    };
    assert!(SourceCredential::from_configuration(&pair("AKIA", SECRET)).is_some());
    assert!(SourceCredential::from_configuration(&pair("", SECRET)).is_none());
    assert!(SourceCredential::from_configuration(&pair("AKIA", "  ")).is_none());
    assert!(SourceCredential::from_configuration(&std::collections::BTreeMap::new()).is_none());
}
