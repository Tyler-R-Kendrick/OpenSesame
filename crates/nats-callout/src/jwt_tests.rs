use super::*;
use crate::fixtures::Parties;

const NOW: i64 = 1_800_000_000;

fn expect_for(p: &Parties) -> Expectations {
    Expectations {
        server_public_keys: vec![p.server.public_key()],
        callout_subject: Some(p.account.public_key()),
        now: NOW,
    }
}

#[test]
fn valid_request_round_trips() {
    let p = Parties::generate();
    let token = p.signed_request(NOW, "tok");
    let verified = decode_request(&token, &expect_for(&p)).expect("verifies");
    assert_eq!(verified.server_public_key, p.server.public_key());
    assert_eq!(verified.claims.sub, p.account.public_key());
    assert_eq!(verified.user_nkey(), p.user.public_key());
    assert_eq!(verified.claims.aud, REQUEST_AUDIENCE);
    assert_eq!(verified.claims.nats.connect_opts.auth_token, "tok");
    assert_eq!(verified.raw(), token);
    assert!(!verified.claims.jti.is_empty());
}

#[test]
fn any_server_is_accepted_only_when_no_pin_is_configured() {
    let p = Parties::generate();
    let token = p.signed_request(NOW, "tok");
    let mut expect = expect_for(&p);
    expect.server_public_keys = vec![nkeys::KeyPair::new_server().public_key()];
    assert_eq!(
        decode_request(&token, &expect).unwrap_err(),
        CalloutError::ServerUnknown
    );
    expect.server_public_keys.clear();
    assert!(decode_request(&token, &expect).is_ok());
}

#[test]
fn signature_by_the_wrong_key_is_refused() {
    let p = Parties::generate();
    let other = nkeys::KeyPair::new_server();
    let mut claims = p.request_claims(NOW, "tok");
    // Claim to be `p.server` but sign with `other`.
    claims.iss = p.server.public_key();
    let forged = encode(&claims, &other).unwrap();
    assert_eq!(
        decode_request(&forged, &expect_for(&p)).unwrap_err(),
        CalloutError::BadSignature
    );
}

#[test]
fn self_signed_by_a_non_server_key_is_refused() {
    let p = Parties::generate();
    let mut claims = p.request_claims(NOW, "tok");
    claims.iss = p.account.public_key();
    let token = encode(&claims, &p.account).unwrap();
    let mut expect = expect_for(&p);
    expect.server_public_keys.clear();
    assert_eq!(
        decode_request(&token, &expect).unwrap_err(),
        CalloutError::IssuerNotServer
    );
}

#[test]
fn tampered_payload_is_refused() {
    let p = Parties::generate();
    let token = p.signed_request(NOW, "tok");
    let mut parts: Vec<&str> = token.split('.').collect();
    let mut claims = p.request_claims(NOW, "tok");
    claims.nats.connect_opts.auth_token = "other".into();
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).unwrap());
    parts[1] = &payload;
    let tampered = parts.join(".");
    assert_eq!(
        decode_request(&tampered, &expect_for(&p)).unwrap_err(),
        CalloutError::BadSignature
    );
}

#[test]
fn algorithm_and_type_are_pinned() {
    let p = Parties::generate();
    let token = p.signed_request(NOW, "tok");
    let payload_and_sig = token.split_once('.').unwrap().1.to_owned();
    for header in [
        r#"{"typ":"JWT","alg":"none"}"#,
        r#"{"typ":"JWT","alg":"HS256"}"#,
        r#"{"typ":"x","alg":"ed25519-nkey"}"#,
    ] {
        let h = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(header);
        let t = format!("{h}.{payload_and_sig}");
        assert_eq!(
            decode_request(&t, &expect_for(&p)).unwrap_err(),
            CalloutError::UnsupportedAlgorithm,
            "{header}"
        );
    }
}

#[test]
fn subject_must_be_the_configured_callout_issuer() {
    let p = Parties::generate();
    // Another account's callout: same server, wrong issuer in `sub`.
    let mut claims = p.request_claims(NOW, "tok");
    claims.sub = nkeys::KeyPair::new_account().public_key();
    assert_eq!(
        decode_request(&p.sign_request(claims), &expect_for(&p)).unwrap_err(),
        CalloutError::SubjectNotCallout
    );
    let mut claims = p.request_claims(NOW, "tok");
    claims.sub = String::new();
    assert_eq!(
        decode_request(&p.sign_request(claims), &expect_for(&p)).unwrap_err(),
        CalloutError::SubjectNotCallout
    );
    // With no pin the subject is accepted (the bridge case), but the user
    // key is still checked.
    let mut expect = expect_for(&p);
    expect.callout_subject = None;
    let mut claims = p.request_claims(NOW, "tok");
    claims.sub = nkeys::KeyPair::new_account().public_key();
    assert!(decode_request(&p.sign_request(claims), &expect).is_ok());
}

#[test]
fn user_nkey_must_be_a_public_user_key() {
    let p = Parties::generate();
    for bad in [
        String::new(),
        "not a key".to_owned(),
        nkeys::KeyPair::new_account().public_key(),
        nkeys::KeyPair::new_user().seed().unwrap(),
    ] {
        let mut claims = p.request_claims(NOW, "tok");
        claims.nats.user_nkey = bad.clone();
        assert_eq!(
            decode_request(&p.sign_request(claims), &expect_for(&p)).unwrap_err(),
            CalloutError::UserNkeyInvalid,
            "{bad:?}"
        );
    }
}

#[test]
fn audience_is_the_protocol_constant_not_the_account() {
    let p = Parties::generate();
    let mut claims = p.request_claims(NOW, "tok");
    claims.aud = p.account.public_key();
    assert_eq!(
        decode_request(&p.sign_request(claims), &expect_for(&p)).unwrap_err(),
        CalloutError::AudienceMismatch
    );
    let mut claims = p.request_claims(NOW, "tok");
    claims.aud = String::new();
    assert_eq!(
        decode_request(&p.sign_request(claims), &expect_for(&p)).unwrap_err(),
        CalloutError::AudienceMismatch
    );
}

#[test]
fn the_signing_server_must_be_the_server_the_claims_name() {
    let p = Parties::generate();
    let mut claims = p.request_claims(NOW, "tok");
    claims.nats.server_id.id = nkeys::KeyPair::new_server().public_key();
    assert_eq!(
        decode_request(&p.sign_request(claims), &expect_for(&p)).unwrap_err(),
        CalloutError::ServerIdMismatch
    );
}

#[test]
fn time_window_is_two_minutes_with_skew() {
    let p = Parties::generate();
    let expect = expect_for(&p);
    // 150 s old with a 2 s exp: expired.
    let old = p.signed_request(NOW - 150, "tok");
    assert_eq!(
        decode_request(&old, &expect).unwrap_err(),
        CalloutError::OutsideWindow
    );
    // No exp but 151 s old: outside the window.
    let mut claims = p.request_claims(NOW - 151, "tok");
    claims.exp = None;
    let stale = p.sign_request(claims);
    assert_eq!(
        decode_request(&stale, &expect).unwrap_err(),
        CalloutError::OutsideWindow
    );
    // No exp, 100 s old: inside.
    let mut claims = p.request_claims(NOW - 100, "tok");
    claims.exp = None;
    assert!(decode_request(&p.sign_request(claims), &expect).is_ok());
    // Issued 31 s in the future: refused; 29 s: tolerated.
    let mut claims = p.request_claims(NOW + 31, "tok");
    claims.exp = None;
    assert_eq!(
        decode_request(&p.sign_request(claims), &expect).unwrap_err(),
        CalloutError::OutsideWindow
    );
    let mut claims = p.request_claims(NOW + 29, "tok");
    claims.exp = None;
    assert!(decode_request(&p.sign_request(claims), &expect).is_ok());
    // nbf in the future.
    let mut claims = p.request_claims(NOW, "tok");
    claims.nbf = Some(NOW + 60);
    assert_eq!(
        decode_request(&p.sign_request(claims), &expect).unwrap_err(),
        CalloutError::OutsideWindow
    );
    // Missing iat.
    let mut claims = p.request_claims(NOW, "tok");
    claims.iat = 0;
    assert_eq!(
        decode_request(&p.sign_request(claims), &expect).unwrap_err(),
        CalloutError::OutsideWindow
    );
}

#[test]
fn wrong_claim_type_or_version_is_refused() {
    let p = Parties::generate();
    let mut claims = p.request_claims(NOW, "tok");
    claims.nats.kind = "authorization_response".into();
    assert!(matches!(
        decode_request(&p.sign_request(claims), &expect_for(&p)).unwrap_err(),
        CalloutError::MalformedRequest(_)
    ));
    let mut claims = p.request_claims(NOW, "tok");
    claims.nats.version = 1;
    assert!(matches!(
        decode_request(&p.sign_request(claims), &expect_for(&p)).unwrap_err(),
        CalloutError::MalformedRequest(_)
    ));
}

#[test]
fn malformed_tokens_are_malformed_not_panics() {
    let p = Parties::generate();
    for bad in ["", "a", "a.b", "a.b.c.d", "!!.!!.!!", "eyJ.eyJ.eyJ"] {
        assert!(decode_request(bad, &expect_for(&p)).is_err(), "{bad:?}");
    }
    let huge = "a".repeat(MAX_REQUEST_BYTES + 1);
    assert!(matches!(
        decode_request(&huge, &expect_for(&p)).unwrap_err(),
        CalloutError::MalformedRequest(_)
    ));
}

#[test]
fn base32_matches_rfc4648_vectors() {
    assert_eq!(base32_no_pad(b""), "");
    assert_eq!(base32_no_pad(b"f"), "MY");
    assert_eq!(base32_no_pad(b"fo"), "MZXQ");
    assert_eq!(base32_no_pad(b"foo"), "MZXW6");
    assert_eq!(base32_no_pad(b"foob"), "MZXW6YQ");
    assert_eq!(base32_no_pad(b"fooba"), "MZXW6YTB");
    assert_eq!(base32_no_pad(b"foobar"), "MZXW6YTBOI");
}
