//! The interaction request digest, recomputed in Rust, against the vectors
//! `packages/os-domain` generates from `crypto/request-digest.ts`
//! (`spec/conformance/request-digest-vectors.json`, ADR 0139).
//!
//! The vector file is the definition. This side must reproduce every
//! canonical-details string and every digest byte for byte; a drift on either
//! side fails a test in that side's suite, and neither side regenerates the
//! file to make itself pass.

use std::collections::HashMap;
use std::path::PathBuf;

use opensesame_agent_hooks::interaction::digest::{
    canonical_details, consumed_hashes_to, es_number_string, request_digest, Basis, DigestError,
    RequestFields, MAX_DEPTH,
};
use serde_json::{json, Value};

fn vectors() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/conformance/request-digest-vectors.json");
    let text = std::fs::read_to_string(path).expect("the vector file is present");
    serde_json::from_str(&text).expect("the vector file parses")
}

fn cases(doc: &Value) -> &Vec<Value> {
    doc["cases"].as_array().expect("cases")
}

fn text<'a>(request: &'a Value, key: &str) -> &'a str {
    request[key].as_str().unwrap_or_else(|| panic!("{key}"))
}

/// The case's details, read the way each reader must: a case that is about
/// how text is read carries the literal, everything else carries a value.
fn details_of(request: &Value) -> Vec<Value> {
    let value = match request["authorizationDetailsJson"].as_str() {
        Some(literal) => serde_json::from_str(literal).expect("the literal parses"),
        None => request["authorizationDetails"].clone(),
    };
    value.as_array().expect("details are a list").clone()
}

fn digest_of(request: &Value, details: &[Value]) -> String {
    request_digest(&RequestFields {
        kind: text(request, "kind"),
        subject: text(request, "subject"),
        approver_ref: text(request, "approverRef"),
        requester_ref: text(request, "requesterRef"),
        authorization_details: details,
        binding_message: text(request, "bindingMessage"),
        resource_ref: request["resourceRef"].as_str(),
        expires_at: text(request, "expiresAt"),
    })
    .expect("a vector is always computable")
}

#[test]
fn every_vector_reproduces_byte_for_byte() {
    let doc = vectors();
    assert!(cases(&doc).len() >= 20, "the corpus shrank");
    for case in cases(&doc) {
        let name = text(case, "name");
        let request = &case["request"];
        let details = details_of(request);
        assert_eq!(
            canonical_details(&details).expect("canonical"),
            text(case, "canonicalDetails"),
            "{name}: canonical details"
        );
        assert_eq!(
            digest_of(request, &details),
            text(case, "digest"),
            "{name}: digest"
        );
    }
}

#[test]
fn the_corpus_still_breaks_a_lazy_reader() {
    // Guards the vector file itself: the cases that make a second
    // implementation earn its agreement must still be in it.
    let doc = vectors();
    let names: Vec<&str> = cases(&doc).iter().map(|c| text(c, "name")).collect();
    for required in [
        "keys_reversed",
        "utf16_key_order",
        "integer_like_keys",
        "proto_key",
        "numbers_beyond_safe",
        "numbers_fractions_and_exponents",
        "negative_zero",
        "escapes",
        "unicode_values",
        "length_prefix_left",
        "length_prefix_right",
        "multibyte_binding_message",
    ] {
        assert!(names.contains(&required), "{required} left the corpus");
    }
}

#[test]
fn distinct_requests_never_share_a_digest_and_equivalents_always_do() {
    let doc = vectors();
    let by_name: HashMap<&str, &str> = cases(&doc)
        .iter()
        .map(|c| (text(c, "name"), text(c, "digest")))
        .collect();
    let mut seen: HashMap<&str, &str> = HashMap::new();
    for case in cases(&doc) {
        let name = text(case, "name");
        let digest = text(case, "digest");
        if let Some(twin) = case["equivalentTo"].as_str() {
            assert_eq!(digest, by_name[twin], "{name} must equal {twin}");
            continue;
        }
        if let Some(clash) = seen.insert(digest, name) {
            panic!("{name} collides with {clash}");
        }
    }
}

#[test]
fn a_document_the_canonical_form_cannot_write_is_an_error_not_a_guess() {
    let mut deep = json!({});
    for _ in 0..=MAX_DEPTH {
        deep = json!({ "k": deep });
    }
    assert_eq!(canonical_details(&[deep]), Err(DigestError::TooDeep));
    let shallow = json!({"k": {"k": {"k": 1}}});
    assert!(canonical_details(&[shallow]).is_ok());
}

#[test]
fn numbers_are_written_as_ecmascript_writes_them() {
    for (value, expected) in [
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (-1.0, "-1"),
        (0.5, "0.5"),
        (1e-7, "1e-7"),
        (0.000_001, "0.000001"),
        (1.5e-7, "1.5e-7"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (1.234_567_890_123_456_8e20, "123456789012345680000"),
        (1.234_567_890_123_456_8e29, "1.2345678901234568e+29"),
        (f64::MAX, "1.7976931348623157e+308"),
        (5e-324, "5e-324"),
        (123_456_789.125, "123456789.125"),
        (-1e-7, "-1e-7"),
    ] {
        assert_eq!(es_number_string(value), expected, "{value:e}");
    }
}

fn consumed(created_digest: &str) -> Value {
    json!({
        "kind": "authorization_request",
        "status": "consumed",
        "requesterRef": "req_abcdefghijklmnopqrstuvwx",
        "bindingMessage": "Approve an agent action: pre_tool_call",
        "expiresAt": "2026-09-28T12:05:00.000Z",
        "requestDigest": created_digest,
        "authorizationDetails": [{"type": "agent_hooks_approval", "actions": ["pre_tool_call"]}],
    })
}

fn expected_for(body: &Value, basis: &Basis<'_>) -> String {
    let subject = format!("authorization_request:{}", basis.subject_id);
    request_digest(&RequestFields {
        kind: "authorization_request",
        subject: &subject,
        approver_ref: basis.approver_ref,
        requester_ref: text(body, "requesterRef"),
        authorization_details: body["authorizationDetails"].as_array().unwrap(),
        binding_message: text(body, "bindingMessage"),
        resource_ref: None,
        expires_at: text(body, "expiresAt"),
    })
    .unwrap()
}

#[test]
fn a_consumed_interaction_is_believed_only_when_it_hashes_to_what_was_asked() {
    let basis = Basis {
        approver_ref: "inbox_YXBwcm92ZXI.tag",
        subject_id: "areq_9",
    };
    let honest = consumed("placeholder");
    let digest = expected_for(&honest, &basis);
    let honest = consumed(&digest);
    assert!(consumed_hashes_to(&honest, &basis, &digest));

    // Each field the digest covers, altered after the fact.
    let alterations: [(&str, Value); 5] = [
        ("requesterRef", json!("req_zzzzzzzzzzzzzzzzzzzzzzzz")),
        ("bindingMessage", json!("Approve something else entirely")),
        ("expiresAt", json!("2026-09-28T13:05:00.000Z")),
        (
            "authorizationDetails",
            json!([{"type": "agent_hooks_approval", "actions": ["output"]}]),
        ),
        ("requestDigest", json!(format!("sha256:{}", "0".repeat(64)))),
    ];
    for (field, value) in alterations {
        let mut body = honest.clone();
        body[field] = value;
        assert!(!consumed_hashes_to(&body, &basis, &digest), "{field}");
    }
    // Another approver, another ceremony.
    let other_approver = Basis {
        approver_ref: "inbox_b3RoZXI.tag",
        ..basis
    };
    assert!(!consumed_hashes_to(&honest, &other_approver, &digest));
    let other_subject = Basis {
        subject_id: "areq_10",
        ..basis
    };
    assert!(!consumed_hashes_to(&honest, &other_subject, &digest));
    // A target handle this approver never named, and a missing field.
    let mut targeted = honest.clone();
    targeted["resourceRef"] = json!("repo:acme/catalog");
    assert!(!consumed_hashes_to(&targeted, &basis, &digest));
    for field in [
        "requesterRef",
        "bindingMessage",
        "expiresAt",
        "requestDigest",
    ] {
        let mut body = honest.clone();
        body.as_object_mut().unwrap().remove(field);
        assert!(!consumed_hashes_to(&body, &basis, &digest), "{field}");
    }
    let mut body = honest;
    body["expiresAt"] = json!(5);
    assert!(!consumed_hashes_to(&body, &basis, &digest));
}
