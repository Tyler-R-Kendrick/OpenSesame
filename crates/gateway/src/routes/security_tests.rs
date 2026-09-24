use super::*;

fn request(secret: &str, subject_id: &str, kind: Option<&str>) -> CheckRequest {
    CheckRequest {
        secret: secret.into(),
        subject_id: subject_id.into(),
        subject_kind: kind.map(str::to_string),
    }
}

#[test]
fn a_valid_request_yields_a_metadata_only_subject() {
    let subject = validate(&request("hunter2", "Dev/api-token", None), "org-1").unwrap();
    assert_eq!(subject.kind, BreachSubjectKind::StorePath);
    assert_eq!(subject.subject_id, "Dev/api-token");
    assert_eq!(subject.organization_id, "org-1");
    let encoded = serde_json::to_string(&subject).unwrap();
    assert!(
        !encoded.contains("hunter2"),
        "a subject must not be able to carry the value it is about",
    );
}

#[test]
fn a_connection_credential_is_an_accepted_kind() {
    let subject = validate(
        &request("hunter2", "conn-1", Some("connection_credential")),
        "org-1",
    )
    .unwrap();
    assert_eq!(subject.kind, BreachSubjectKind::ConnectionCredential);
}

#[test]
fn a_kind_with_nothing_to_open_is_refused() {
    for kind in ["domain", "breach_source"] {
        let error = validate(&request("hunter2", "adobe.com", Some(kind)), "org-1").unwrap_err();
        assert!(error.contains("store_path"), "{kind}: {error}");
    }
}

#[test]
fn an_unknown_kind_is_refused() {
    assert!(validate(&request("hunter2", "x", Some("planet")), "org-1").is_err());
}

#[test]
fn an_empty_secret_is_refused_rather_than_hashed() {
    let error = validate(&request("", "Dev/api-token", None), "org-1").unwrap_err();
    assert!(error.contains("empty"), "{error}");
}

#[test]
fn an_oversized_secret_is_refused() {
    let long = "x".repeat(MAX_SECRET_BYTES + 1);
    let error = validate(&request(&long, "Dev/api-token", None), "org-1").unwrap_err();
    assert!(error.contains("bytes"), "{error}");
}

#[test]
fn a_missing_or_oversized_subject_is_refused() {
    assert!(validate(&request("hunter2", "", None), "org-1").is_err());
    let long = "x".repeat(MAX_SUBJECT_CHARS + 1);
    assert!(validate(&request("hunter2", &long, None), "org-1").is_err());
}

#[test]
fn a_finding_renders_as_metadata_only() {
    let row = StoredBreachFinding {
        organization_id: "org-1".into(),
        subject_kind: "store_path".into(),
        subject_id: "Dev/api-token".into(),
        source: "hibp_passwords".into(),
        reference: String::new(),
        severity: "critical".into(),
        occurrences: Some(42),
        state: "open".into(),
        first_seen_at: "2026-08-30T00:00:00+00:00".into(),
        last_seen_at: "2026-08-30T00:00:00+00:00".into(),
        cleared_at: None,
    };
    let rendered = finding_json(&row);
    let object = rendered.as_object().unwrap();
    assert_eq!(object["occurrences"], json!(42));
    for key in object.keys() {
        for forbidden in ["secret", "password", "token", "credential"] {
            assert!(!key.contains(forbidden), "finding grew {key}");
        }
    }
}

#[test]
fn the_limit_is_clamped_into_a_sane_range() {
    for (asked, expected) in [
        (None, DEFAULT_FINDING_LIMIT),
        (Some(0), 1),
        (Some(10_000), MAX_FINDING_LIMIT),
        (Some(25), 25),
    ] {
        let limit = asked
            .unwrap_or(DEFAULT_FINDING_LIMIT)
            .clamp(1, MAX_FINDING_LIMIT);
        assert_eq!(limit, expected, "asked {asked:?}");
    }
}
