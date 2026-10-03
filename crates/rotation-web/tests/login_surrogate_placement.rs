//! Placement: the surrogate is substituted only as the whole value of the one
//! declared field, exactly once (ADR 0150 §6.3). Each test is one way a page
//! script could move it somewhere else, and each is refused as `Misplaced` —
//! the credential would never have been written there, so a find-and-replace
//! that wrote it there anyway is the attack.

#![cfg(feature = "login-surrogate")]

mod login_support;

use login_support::{assert_refused, declared, form, json, post, run, secret, SURROGATE};
use opensesame_rotation_web::{Egress, RefusalCode};

const S: &str = SURROGATE;

#[test]
fn surrogate_moved_to_another_form_field_is_misplaced() {
    let body = format!("user=a%40b.example&password=wrong&comment={S}");
    let refusal = assert_refused(run(&form(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("form-field"));
}

#[test]
fn surrogate_moved_to_a_form_key_is_misplaced() {
    let body = format!("password=x&{S}=1");
    let refusal = assert_refused(run(&form(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("form-key"));
}

#[test]
fn surrogate_percent_encoded_into_another_field_is_misplaced() {
    let encoded = S.replace('_', "%5F");
    let body = format!("password=x&note={encoded}");
    assert_refused(run(&form(), &body), RefusalCode::Misplaced);
}

#[test]
fn surrogate_moved_to_the_query_string_is_misplaced() {
    let url = format!("https://login.example/session?leak={S}");
    let headers = form();
    let body = format!("password={S}");
    let refusal = assert_refused(
        declared().substitute(&post(&url, &headers, body.as_bytes()), &secret()),
        RefusalCode::Misplaced,
    );
    assert_eq!(refusal.detail.as_deref(), Some("query"));
}

#[test]
fn surrogate_percent_encoded_in_the_query_string_is_misplaced() {
    let url = format!(
        "https://login.example/session?leak={}",
        S.replace('o', "%6F")
    );
    let headers = form();
    let body = "password=x";
    assert_refused(
        declared().substitute(&post(&url, &headers, body.as_bytes()), &secret()),
        RefusalCode::Misplaced,
    );
}

#[test]
fn surrogate_in_a_header_is_misplaced() {
    let mut headers = form();
    headers.push(("X-Debug".into(), format!("pw={S}")));
    let body = format!("password={S}");
    let refusal = assert_refused(run(&headers, &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("x-debug"));
}

#[test]
fn surrogate_duplicated_in_a_second_form_field_is_misplaced() {
    let body = format!("password={S}&password2={S}");
    assert_refused(run(&form(), &body), RefusalCode::Misplaced);
}

#[test]
fn declared_form_field_repeated_is_misplaced() {
    let body = format!("password={S}&password={S}");
    let refusal = assert_refused(run(&form(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("form-field-repeated"));
}

#[test]
fn surrogate_twice_in_the_declared_value_is_misplaced() {
    let body = format!("password={S}{S}");
    assert_refused(run(&form(), &body), RefusalCode::Misplaced);
}

#[test]
fn surrogate_as_part_of_the_declared_value_is_misplaced() {
    let body = format!("password=prefix-{S}");
    assert_refused(run(&form(), &body), RefusalCode::Misplaced);
}

#[test]
fn surrogate_duplicated_in_a_second_json_member_is_misplaced() {
    let body = format!(r#"{{"password":"{S}","backup":"{S}"}}"#);
    assert_refused(run(&json(), &body), RefusalCode::Misplaced);
}

#[test]
fn declared_json_key_repeated_is_misplaced() {
    let body = format!(r#"{{"password":"{S}","password":"{S}"}}"#);
    let refusal = assert_refused(run(&json(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("json-repeated"));
}

#[test]
fn surrogate_in_nested_json_is_misplaced() {
    let body = format!(r#"{{"credentials":{{"password":"{S}"}}}}"#);
    let refusal = assert_refused(run(&json(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("json-nested"));
}

#[test]
fn declared_json_field_holding_an_object_is_misplaced() {
    let body = format!(r#"{{"password":{{"value":"{S}"}}}}"#);
    let refusal = assert_refused(run(&json(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("json-nested"));
}

#[test]
fn surrogate_in_a_json_array_is_misplaced() {
    let body = format!(r#"{{"password":["{S}"]}}"#);
    let refusal = assert_refused(run(&json(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("json-array"));
}

#[test]
fn top_level_json_array_is_misplaced() {
    let body = format!(r#"[{{"password":"{S}"}}]"#);
    let refusal = assert_refused(run(&json(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("json-array"));
}

#[test]
fn surrogate_as_a_json_key_is_misplaced() {
    let body = format!(r#"{{"password":"x","{S}":true}}"#);
    let refusal = assert_refused(run(&json(), &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("json-key"));
}

#[test]
fn surrogate_in_a_multipart_body_is_misplaced() {
    let headers = login_support::headers("multipart/form-data; boundary=XyZ");
    let body = format!(
        "--XyZ\r\nContent-Disposition: form-data; name=\"password\"\r\n\r\n{S}\r\n--XyZ--\r\n"
    );
    let refusal = assert_refused(run(&headers, &body), RefusalCode::Misplaced);
    assert_eq!(refusal.detail.as_deref(), Some("body"));
}

#[test]
fn surrogate_in_a_text_body_is_misplaced() {
    let headers = login_support::headers("text/plain");
    assert_refused(
        run(&headers, &format!("password={S}")),
        RefusalCode::Misplaced,
    );
}

#[test]
fn a_different_surrogate_in_the_declared_field_is_misplaced() {
    let other = "osr_ffffffffffffffffffffffffffffffff";
    let body = format!("password={other}");
    assert_refused(run(&form(), &body), RefusalCode::Misplaced);
}

#[test]
fn a_transformed_surrogate_is_absent_not_substituted() {
    // What a page that hashes or uppercases the field sends. Nothing to place
    // the credential into; the login falls back to CDP fill.
    let body = format!("password={}", S.to_ascii_uppercase());
    assert_refused(run(&form(), &body), RefusalCode::Absent);
    assert_refused(
        run(&json(), r#"{"password":"5e884898da2804"}"#),
        RefusalCode::Absent,
    );
}

#[test]
fn a_request_carrying_no_surrogate_passes_the_hook_untouched() {
    let substitution = declared();
    let headers = form();
    for (url, body) in [
        ("https://login.example/session", "user=a&password=5e884898"),
        ("https://cdn.example/analytics", "event=view"),
    ] {
        let egress = substitution
            .egress(&post(url, &headers, body.as_bytes()), &secret())
            .unwrap();
        assert!(matches!(egress, Egress::Untouched), "{url}");
    }
}

#[test]
fn a_second_substitution_in_one_attempt_is_replayed() {
    let substitution = declared();
    let headers = form();
    let body = format!("password={S}");
    let request = post(login_support::URL, &headers, body.as_bytes());
    assert!(substitution.substitute(&request, &secret()).is_ok());
    assert_refused(
        substitution.substitute(&request, &secret()),
        RefusalCode::Replayed,
    );
}
