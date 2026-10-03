//! The credential arrives byte for byte, and is never printed.
//!
//! ADR 0076 §6 rejected byte-level substitution partly because it "mangles
//! secrets containing `&`, `=` or `%` in form encoding". The fix is to parse
//! and re-encode, so these tests decode what substitution produced the way a
//! server would and compare the result with the secret exactly.

#![cfg(feature = "login-surrogate")]

mod login_support;

use login_support::{declared, form, json, post, run, secret, SECRET, SURROGATE, URL};
use opensesame_rotation_web::{
    Egress, EgressReport, LoginRequest, Refusal, RefusalCode, ResponseScrub,
};
use secrecy::SecretString;

/// Decode an `application/x-www-form-urlencoded` body the way a server does.
fn decode_form(body: &[u8]) -> Vec<(String, String)> {
    let decode = |part: &[u8]| {
        let mut out = Vec::new();
        let mut i = 0;
        while i < part.len() {
            match part[i] {
                b'+' => out.push(b' '),
                b'%' => {
                    let hex = std::str::from_utf8(&part[i + 1..i + 3]).unwrap();
                    out.push(u8::from_str_radix(hex, 16).unwrap());
                    i += 2;
                }
                byte => out.push(byte),
            }
            i += 1;
        }
        String::from_utf8(out).unwrap()
    };
    body.split(|b| *b == b'&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let at = pair.iter().position(|b| *b == b'=').unwrap_or(pair.len());
            let value = pair.get(at + 1..).unwrap_or_default();
            (decode(&pair[..at]), decode(value))
        })
        .collect()
}

#[test]
fn a_secret_with_form_metacharacters_round_trips_through_form_encoding() {
    let body = format!("user=a%40b.example&password={SURROGATE}&remember=on");
    let substituted = run(&form(), &body).unwrap();
    let pairs = decode_form(substituted.body());
    assert_eq!(
        pairs,
        vec![
            ("user".to_string(), "a@b.example".to_string()),
            ("password".to_string(), SECRET.to_string()),
            ("remember".to_string(), "on".to_string()),
        ]
    );
    assert_eq!(substituted.len(), substituted.body().len());
}

#[test]
fn a_secret_with_json_metacharacters_round_trips_through_json() {
    let body = format!(r#"{{"username":"a@b.example","password":"{SURROGATE}","remember":true}}"#);
    let substituted = run(&json(), &body).unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(substituted.body()).unwrap();
    assert_eq!(parsed["password"], SECRET);
    assert_eq!(parsed["username"], "a@b.example");
    assert_eq!(parsed["remember"], true);
    assert_eq!(parsed.as_object().unwrap().len(), 3);
}

#[test]
fn every_ascii_byte_round_trips_through_both_formats() {
    let every: String = (0x20u8..0x7f)
        .map(char::from)
        .chain(['\t', 'ü', '🔑'])
        .collect();
    let credential = SecretString::from(every.clone());
    let headers = form();
    let body = format!("password={SURROGATE}");
    let out = declared()
        .substitute(&post(URL, &headers, body.as_bytes()), &credential)
        .unwrap();
    assert_eq!(decode_form(out.body())[0].1, every);

    let headers = json();
    let body = format!(r#"{{"password":"{SURROGATE}"}}"#);
    let out = declared()
        .substitute(&post(URL, &headers, body.as_bytes()), &credential)
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(out.body()).unwrap();
    assert_eq!(parsed["password"], every.as_str());
}

#[test]
fn credential_never_appears_in_debug_of_any_type() {
    let substitution = declared();
    let headers = form();
    let body = format!("password={SURROGATE}");
    let request = post(URL, &headers, body.as_bytes());
    let url = format!("https://login.example/session?leak={SURROGATE}");
    let leaky = LoginRequest {
        method: "POST",
        url: &url,
        headers: &headers,
        body: body.as_bytes(),
    };
    let credential = secret();
    let scrub = ResponseScrub::new(&credential);
    let before = format!("{substitution:?} {request:?} {leaky:?} {credential:?} {scrub:?}");
    let substituted = substitution.substitute(&request, &credential).unwrap();
    let egress = Egress::Substituted(run(&form(), &body).unwrap());
    let refusal: Refusal = run(&form(), &format!("x={SURROGATE}")).unwrap_err();
    let report = EgressReport::Refused(refusal.clone());
    let after = format!(
        "{substituted:?} {egress:?} {refusal:?} {report:?} {:?} {:?}",
        substitution.surrogate(),
        refusal.next()
    );
    for shown in [before, after] {
        assert!(!shown.contains(SECRET), "credential in Debug: {shown}");
        assert!(!shown.contains(SURROGATE), "surrogate in Debug: {shown}");
        assert!(
            !shown.contains("pa&ss"),
            "credential fragment in Debug: {shown}"
        );
    }
}

#[test]
fn the_page_learns_one_message_whatever_the_fence() {
    let codes = [
        RefusalCode::Misdirected,
        RefusalCode::Misplaced,
        RefusalCode::Unsupported,
        RefusalCode::Absent,
        RefusalCode::Replayed,
    ];
    let names: std::collections::HashSet<&str> = codes.iter().map(|c| c.as_str()).collect();
    assert_eq!(names.len(), codes.len());
    assert!(!Refusal::CLIENT_MESSAGE.contains("surrogate"));
}
