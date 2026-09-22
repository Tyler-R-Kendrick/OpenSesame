//! Runs the JSON corpus under `fixtures/` that `@opensesame/ingress-evidence`
//! also runs, so both parsers are pinned to one set of outcomes.

use http::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::{parse_client_cert_fields, IngressLimits};

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    headers: Vec<(String, String)>,
    limits: Option<Limits>,
    expect: Expect,
}

// Field names mirror the JSON keys, which mirror `IngressLimits`.
#[allow(clippy::struct_field_names)]
#[derive(Deserialize)]
struct Limits {
    max_certificate_bytes: usize,
    max_chain_certificates: usize,
    max_total_header_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Expect {
    Ok {
        leaf_sha256: String,
        intermediates_sha256: Vec<String>,
    },
    Error(String),
}

fn corpus(name: &str) -> Corpus {
    let path = format!("{}/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("corpus file readable");
    serde_json::from_str(&text).expect("corpus file well-formed")
}

fn header_map(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes()).expect("fixture header name");
        // Non-ASCII fixture text is carried as obs-text bytes, as a wire peer would send it.
        let value = HeaderValue::from_bytes(value.as_bytes()).expect("fixture header value");
        map.append(name, value);
    }
    map
}

fn run(name: &str) {
    let corpus = corpus(name);
    assert!(!corpus.cases.is_empty(), "{name}: corpus has cases");
    for case in &corpus.cases {
        let limits = case
            .limits
            .as_ref()
            .map_or(IngressLimits::DEFAULT, |l| IngressLimits {
                max_certificate_bytes: l.max_certificate_bytes,
                max_chain_certificates: l.max_chain_certificates,
                max_total_header_bytes: l.max_total_header_bytes,
            });
        let result = parse_client_cert_fields(&header_map(&case.headers), &limits);
        match (&case.expect, result) {
            (
                Expect::Ok {
                    leaf_sha256,
                    intermediates_sha256,
                },
                Ok(chain),
            ) => {
                assert_eq!(
                    chain.leaf_thumbprint_sha256(),
                    leaf_sha256,
                    "{name}/{}: leaf",
                    case.name
                );
                assert_eq!(
                    hex::encode(Sha256::digest(chain.leaf_der())),
                    *leaf_sha256,
                    "{name}/{}: leaf bytes",
                    case.name
                );
                let got: Vec<String> = chain
                    .intermediates_der()
                    .iter()
                    .map(|der| hex::encode(Sha256::digest(der)))
                    .collect();
                assert_eq!(&got, intermediates_sha256, "{name}/{}: chain", case.name);
            }
            (Expect::Error(code), Err(err)) => {
                assert_eq!(err.code(), code, "{name}/{}: error code", case.name);
            }
            (Expect::Ok { .. }, Err(err)) => {
                panic!("{name}/{}: expected ok, got {err:?}", case.name)
            }
            (Expect::Error(code), Ok(chain)) => {
                panic!("{name}/{}: expected {code}, got {chain:?}", case.name);
            }
        }
    }
}

#[test]
fn valid_corpus() {
    run("valid");
}

#[test]
fn structure_corpus() {
    run("structure");
}

#[test]
fn limits_corpus() {
    run("limits");
}

#[test]
fn every_error_code_is_pinned_by_the_corpus() {
    let mut seen = std::collections::BTreeSet::new();
    for name in ["valid", "structure", "limits"] {
        for case in corpus(name).cases {
            if let Expect::Error(code) = case.expect {
                seen.insert(code);
            }
        }
    }
    let all = [
        "header_bytes_exceeded",
        "leaf_missing",
        "leaf_repeated",
        "malformed_structured_field",
        "not_byte_sequence",
        "parameters_present",
        "empty_item",
        "certificate_too_large",
        "chain_too_long",
        "not_der_certificate",
        "conflicting_leaf",
    ];
    for code in all {
        assert!(seen.contains(code), "corpus pins {code}");
    }
}
