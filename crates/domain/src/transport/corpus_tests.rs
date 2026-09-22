//! Shared JSON corpus: the same fixtures `packages/contracts` runs through
//! zod, read here through serde. A fixture names its `kind`, an `input`, and
//! an `expect` block — either `{ ok: true, canonical }` (the parsed value
//! must re-serialize to exactly `canonical`) or `{ ok: false, error }` (the
//! error code). `binding_resolution` fixtures expect `binding_id` instead.

use super::*;
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/fixtures/transport-security")
}

fn fixtures() -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for sub in ["valid", "invalid"] {
        let dir = corpus_dir().join(sub);
        let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        paths.sort();
        for path in paths {
            let raw = fs::read_to_string(&path).unwrap();
            let doc: Value =
                serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            out.push((
                format!("{sub}/{}", path.file_name().unwrap().to_string_lossy()),
                doc,
            ));
        }
    }
    out
}

fn parse<T: DeserializeOwned + serde::Serialize>(input: &Value) -> Result<Value, TransportError> {
    let parsed: T = serde_json::from_value(input.clone())
        .map_err(|e| TransportError::malformed(e.to_string()))?;
    Ok(serde_json::to_value(parsed).unwrap())
}

fn parse_validated<T>(
    input: &Value,
    validate: fn(&T) -> Result<(), TransportError>,
) -> Result<Value, TransportError>
where
    T: DeserializeOwned + serde::Serialize,
{
    let parsed: T = serde_json::from_value(input.clone())
        .map_err(|e| TransportError::malformed(e.to_string()))?;
    validate(&parsed)?;
    Ok(serde_json::to_value(parsed).unwrap())
}

fn resolve(input: &Value) -> Result<Value, TransportError> {
    let set = ServiceBindingSet::parse_json(&input["set"].to_string())?;
    let scope: BindingScope = serde_json::from_value(input["scope"].clone())
        .map_err(|e| TransportError::malformed(e.to_string()))?;
    let profile: TrustProfileRef = serde_json::from_value(input["profile"].clone())
        .map_err(|e| TransportError::malformed(e.to_string()))?;
    let presented: Vec<PeerIdentitySelector> =
        serde_json::from_value(input["presented"].clone())
            .map_err(|e| TransportError::malformed(e.to_string()))?;
    let purpose: BindingPurpose = serde_json::from_value(input["purpose"].clone())
        .map_err(|e| TransportError::malformed(e.to_string()))?;
    let now: DateTime<Utc> = timestamp::parse(input["now"].as_str().unwrap())
        .map_err(|e| TransportError::malformed(e.to_string()))?;
    let binding = set.resolve_scoped(&scope, &profile, &presented, purpose, now)?;
    Ok(Value::String(binding.id.clone()))
}

fn run(kind: &str, input: &Value) -> Result<Value, TransportError> {
    match kind {
        "service_binding_set" => {
            parse_validated::<ServiceBindingSet>(input, ServiceBindingSet::validate)
        }
        "peer_identity_selector" => parse::<PeerIdentitySelector>(input),
        "transport_policy" => parse::<TransportPolicy>(input),
        "transport_capabilities" => {
            parse_validated::<TransportCapabilities>(input, TransportCapabilities::validate)
        }
        "peer_evidence_view" => parse::<PeerEvidenceView>(input),
        "transport_status_view" => {
            parse_validated::<TransportStatusView>(input, TransportStatusView::validate)
        }
        "timestamp" => {
            let raw = input
                .as_str()
                .ok_or_else(|| TransportError::malformed("timestamp: not a string"))?;
            timestamp::parse(raw)
                .map(|t| Value::String(timestamp::canonical(&t)))
                .map_err(|e| TransportError::malformed(e.to_string()))
        }
        "binding_resolution" => resolve(input),
        other => panic!("unknown fixture kind {other}"),
    }
}

#[test]
fn every_fixture_parses_to_its_expected_outcome() {
    let all = fixtures();
    assert!(all.len() >= 30, "corpus has {} fixtures", all.len());
    let mut kinds = std::collections::BTreeSet::new();
    for (name, doc) in &all {
        let kind = doc["kind"]
            .as_str()
            .unwrap_or_else(|| panic!("{name}: kind"));
        kinds.insert(kind.to_owned());
        let expect = &doc["expect"];
        let outcome = run(kind, &doc["input"]);
        match (expect["ok"].as_bool(), outcome) {
            (Some(true), Ok(value)) => {
                let want = if kind == "binding_resolution" {
                    &expect["binding_id"]
                } else {
                    &expect["canonical"]
                };
                assert_eq!(&value, want, "{name}: canonical form differs");
                assert!(
                    name.starts_with("valid/"),
                    "{name}: ok fixtures live under valid/"
                );
            }
            (Some(false), Err(err)) => {
                assert_eq!(
                    err.code(),
                    expect["error"].as_str().unwrap(),
                    "{name}: error code differs ({err})"
                );
                assert!(
                    name.starts_with("invalid/"),
                    "{name}: error fixtures live under invalid/"
                );
            }
            (want, got) => panic!("{name}: expected ok={want:?}, got {got:?}"),
        }
    }
    for kind in [
        "service_binding_set",
        "peer_identity_selector",
        "transport_policy",
        "transport_capabilities",
        "peer_evidence_view",
        "transport_status_view",
        "timestamp",
        "binding_resolution",
    ] {
        assert!(kinds.contains(kind), "corpus lost kind {kind}");
    }
}
