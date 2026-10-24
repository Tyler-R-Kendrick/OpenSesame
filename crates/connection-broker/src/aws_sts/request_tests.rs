//! Duration caps, the session-name charset and the request's encoding.

use super::*;

#[test]
fn the_duration_defaults_to_900_and_never_passes_the_cap() {
    assert_eq!(duration_for(None, 3600), Ok(900));
    assert_eq!(duration_for(Some(1800), 1800), Ok(1800));
    assert_eq!(duration_for(Some(3600), 3600), Ok(3600));
    assert!(
        duration_for(Some(1801), 1800).is_err(),
        "above the binding's cap"
    );
    assert!(duration_for(Some(899), 3600).is_err(), "below STS's floor");
    // A cap stored above the Host's ceiling still cannot buy more than an hour.
    assert!(duration_for(Some(7200), 7200).is_err());
    assert_eq!(duration_for(Some(3600), 43_200), Ok(3600));
}

#[test]
fn the_session_name_is_the_grant_id_in_sts_charset() {
    let name = session_name("0192f3c4a1b27e8d9c0f1a2b3c4d5e6f").unwrap();
    assert_eq!(name, "opensesame-0192f3c4a1b27e8d9c0f1a2b3c4d5e6f");
    assert!(valid_sts_name(&name));
    for bad in ["has space", "slash/", "colon:", "quote\"", &"a".repeat(60)] {
        assert!(session_name(bad).is_err(), "{bad}");
    }
    assert!(!valid_sts_name("a"));
    assert!(valid_sts_name("a_b+c=d,e.f@g-h"));
}

#[test]
fn source_identity_keeps_the_principal_and_stays_in_charset() {
    assert_eq!(source_identity("operator"), "operator");
    let encoded = source_identity("principal:0000-1111");
    assert_eq!(encoded, "principal=3A0000-1111");
    assert!(valid_sts_name(&encoded));
    // `=` is escaped too, so two principals never encode alike.
    assert_ne!(source_identity("a=3A"), source_identity("a:"));
    let long = source_identity(&format!("principal:{}", "x".repeat(200)));
    assert_eq!(long.len(), 64);
    assert!(valid_sts_name(&long));
    assert_ne!(
        long,
        source_identity(&format!("principal:{}y", "x".repeat(199)))
    );
    assert!(valid_sts_name(&source_identity("")));
    assert!(!source_identity("aws:x").starts_with("aws:"));
}

fn request() -> AssumeRoleRequest {
    AssumeRoleRequest {
        role_arn: "arn:aws:iam::123456789012:role/Deploy".into(),
        role_session_name: "opensesame-grant".into(),
        duration_seconds: 900,
        policy: Some(r#"{"Version":"2012-10-17","Statement":[]}"#.into()),
        source_identity: "operator".into(),
        external_id: Some(SecretString::from("vtok_dummy_marker_0123456789abcdef")),
    }
}

#[test]
fn the_form_carries_every_parameter_and_debug_hides_the_external_id() {
    let body = request().form_body();
    let form: std::collections::BTreeMap<String, String> = form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    assert_eq!(form["Action"], "AssumeRole");
    assert_eq!(form["Version"], "2011-06-15");
    assert_eq!(form["RoleArn"], "arn:aws:iam::123456789012:role/Deploy");
    assert_eq!(form["RoleSessionName"], "opensesame-grant");
    assert_eq!(form["DurationSeconds"], "900");
    assert_eq!(form["SourceIdentity"], "operator");
    assert_eq!(form["Policy"], r#"{"Version":"2012-10-17","Statement":[]}"#);
    assert_eq!(form["ExternalId"], "vtok_dummy_marker_0123456789abcdef");
    let shown = format!("{:?}", request());
    assert!(!shown.contains("vtok_dummy_marker"), "{shown}");
}
