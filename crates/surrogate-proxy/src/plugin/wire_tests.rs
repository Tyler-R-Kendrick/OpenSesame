use super::*;

fn line(run_id: &str, ttl: u64, notices: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "run_id": run_id,
        "ttl_secs": ttl,
        "entries": [{
            "env_var": "GITHUB_TOKEN",
            "provider_id": "github",
            "connection_ref": "conn://local/github",
            "site": "authorization",
            "methods": ["GET"],
            "path_prefixes": ["/user", "/repos/acme"],
        }],
        "notices_path": notices,
    }))
    .unwrap()
}

#[test]
fn a_well_formed_spec_parses() {
    let request = parse_request(&line("dev-1", 60, "/tmp/n.jsonl")).unwrap();
    assert_eq!(request.entries.len(), 1);
    let (spec, unserved) = to_run_spec(&request).unwrap();
    assert_eq!(spec.grants.len(), 1);
    assert!(unserved.is_empty());
    assert_eq!(spec.grants[0].site, SurrogateSite::Authorization);
}

#[test]
fn a_run_id_that_traverses_is_refused() {
    for id in ["../x", "a/b", "", ".hidden", "a b", &"x".repeat(200)] {
        assert_eq!(
            parse_request(&line(id, 60, "/tmp/n")).unwrap_err(),
            SpecError::RunId,
            "{id}"
        );
    }
}

#[test]
fn an_unbounded_or_zero_ttl_is_refused() {
    assert_eq!(
        parse_request(&line("r", 0, "/tmp/n")).unwrap_err(),
        SpecError::Ttl
    );
    assert_eq!(
        parse_request(&line("r", MAX_TTL_SECS + 1, "/tmp/n")).unwrap_err(),
        SpecError::Ttl
    );
}

#[test]
fn a_relative_notices_path_is_refused() {
    assert_eq!(
        parse_request(&line("r", 60, "notices.jsonl")).unwrap_err(),
        SpecError::NoticesPath
    );
}

#[test]
fn an_unknown_field_is_refused_not_ignored() {
    let mut value: serde_json::Value = serde_json::from_slice(&line("r", 60, "/tmp/n")).unwrap();
    value["scope_everything"] = serde_json::json!(true);
    let bytes = serde_json::to_vec(&value).unwrap();
    assert_eq!(parse_request(&bytes).unwrap_err(), SpecError::Malformed);
}

#[test]
fn an_oversized_spec_is_refused_before_parsing() {
    let big = vec![b' '; MAX_SPEC_BYTES + 1];
    assert_eq!(parse_request(&big).unwrap_err(), SpecError::TooLarge);
}

#[test]
fn a_provider_this_build_cannot_broker_is_unserved_not_issued() {
    let mut request = parse_request(&line("r", 60, "/tmp/n")).unwrap();
    request.entries[0].provider_id = "workos".into();
    let (spec, unserved) = to_run_spec(&request).unwrap();
    assert!(spec.grants.is_empty());
    assert_eq!(unserved, vec!["GITHUB_TOKEN".to_owned()]);
}

#[test]
fn sites_parse_strictly() {
    assert_eq!(
        parse_site("header:X-Api-Key").unwrap(),
        SurrogateSite::Header("x-api-key".into())
    );
    for bad in [
        "cookie",
        "header:",
        "header:a b",
        "header:authorization",
        "body",
    ] {
        assert_eq!(parse_site(bad).unwrap_err(), SpecError::Site, "{bad}");
    }
}

#[test]
fn an_error_reply_is_a_class() {
    let reply = ErrorReply {
        error: SpecError::Malformed.class(),
    };
    assert_eq!(
        serde_json::to_string(&reply).unwrap(),
        r#"{"error":"spec_malformed"}"#
    );
}

/// The scope is the narrowest operation the child needs (ADR 0150 section 8):
/// a served entry with no prefix, or only the root, would let a leaked
/// surrogate reach every endpoint the provider's host serves.
#[test]
fn a_served_entry_without_a_bounded_path_scope_is_refused() {
    for prefixes in [
        serde_json::json!([]),
        serde_json::json!(["/"]),
        serde_json::json!(["//"]),
        serde_json::json!(["/user", "/"]),
        serde_json::json!(["repos"]),
        serde_json::json!(["/repos/../admin"]),
        serde_json::json!(["/repos/./x"]),
        serde_json::json!(["/a?b=1"]),
        serde_json::json!(["/a#b"]),
        serde_json::json!(["/a b"]),
        serde_json::json!(["/a//b"]),
        serde_json::json!([""]),
    ] {
        let mut value: serde_json::Value =
            serde_json::from_slice(&line("r", 60, "/tmp/n")).unwrap();
        value["entries"][0]["path_prefixes"] = prefixes.clone();
        let request = parse_request(&serde_json::to_vec(&value).unwrap()).unwrap();
        let error = to_run_spec(&request).expect_err(&format!("{prefixes} must be refused"));
        assert_eq!(error.class(), "spec_path_scope:GITHUB_TOKEN", "{prefixes}");
    }
}

#[test]
fn a_bounded_scope_is_carried_into_the_grant_as_declared() {
    let request = parse_request(&line("r", 60, "/tmp/n")).unwrap();
    let (spec, _) = to_run_spec(&request).unwrap();
    assert_eq!(spec.grants[0].path_prefixes, ["/user", "/repos/acme"]);
    assert_eq!(spec.grants[0].methods, ["GET"]);
}

#[test]
fn an_unserved_entry_needs_no_scope_because_nothing_is_issued_for_it() {
    let mut request = parse_request(&line("r", 60, "/tmp/n")).unwrap();
    request.entries[0].provider_id = "workos".into();
    request.entries[0].path_prefixes.clear();
    let (spec, unserved) = to_run_spec(&request).unwrap();
    assert!(spec.grants.is_empty());
    assert_eq!(unserved, vec!["GITHUB_TOKEN".to_owned()]);
}

#[test]
fn a_served_entry_without_methods_is_refused_too() {
    let mut request = parse_request(&line("r", 60, "/tmp/n")).unwrap();
    request.entries[0].methods.clear();
    assert!(to_run_spec(&request).is_err());
}

#[test]
fn the_shared_vectors_decide_what_bounds_a_path() {
    let all: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../spec/conformance/surrogate-scope.json"
    ))
    .unwrap();
    for (kind, expected) in [("bounded", true), ("unbounded", false)] {
        for prefix in all[kind].as_array().unwrap() {
            let prefix = prefix.as_str().unwrap();
            assert_eq!(is_bounded_prefix(prefix), expected, "{prefix:?}");
        }
    }
}
