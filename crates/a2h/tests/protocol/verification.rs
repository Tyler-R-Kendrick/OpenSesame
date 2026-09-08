use super::*;

fn reply() -> A2hResponse {
    A2hResponse {
        message_type: IntentType::Response,
        interaction_id: "int-1".into(),
        responds_to: "msg-1".into(),
        decision: Some(Decision::Approve),
        decided_at: Some(now().to_rfc3339()),
        evidence: None,
        signature: None,
    }
}

fn header(timestamp: i64, body: &str) -> String {
    format!(
        "t={timestamp},v1={}",
        opensesame_a2h::sign(SECRET, timestamp, body).unwrap()
    )
}

fn expected(now_unix: i64) -> ExpectedReply<'static> {
    ExpectedReply {
        message_id: "msg-1",
        already_applied: false,
        now_unix,
    }
}

#[test]
fn a_well_formed_callback_verifies() {
    let body = serde_json::to_string(&reply()).unwrap();
    let ts = now().timestamp();
    assert_eq!(
        verify_callback(SECRET, &header(ts, &body), &body, &reply(), &expected(ts)),
        Ok(())
    );
}

#[test]
fn a_tampered_body_is_refused() {
    let body = serde_json::to_string(&reply()).unwrap();
    let ts = now().timestamp();
    let signature = header(ts, &body);
    let swapped = body.replace("APPROVE", "DECLINE");
    assert_eq!(
        verify_callback(SECRET, &signature, &swapped, &reply(), &expected(ts)),
        Err(VerifyError::BadSignature)
    );
}

#[test]
fn a_captured_signature_stops_working() {
    let body = serde_json::to_string(&reply()).unwrap();
    let ts = now().timestamp();
    let stale = ts - TIMESTAMP_TOLERANCE_SECONDS - 1;
    assert_eq!(
        verify_callback(
            SECRET,
            &header(stale, &body),
            &body,
            &reply(),
            &expected(ts)
        ),
        Err(VerifyError::StaleTimestamp)
    );
}

#[test]
fn extreme_signed_timestamps_and_ambiguous_headers_fail_closed() {
    let body = serde_json::to_string(&reply()).unwrap();
    for timestamp in [i64::MIN, i64::MAX] {
        assert_eq!(
            verify_callback(
                SECRET,
                &header(timestamp, &body),
                &body,
                &reply(),
                &expected(now().timestamp())
            ),
            Err(VerifyError::StaleTimestamp),
        );
    }
    for malformed in ["t=1,t=2,v1=x", "t=1,v1=x,v1=y", "t=1,v1=x,other=y"] {
        assert_eq!(
            opensesame_a2h::parse_signature(malformed),
            Err(VerifyError::MalformedHeader)
        );
    }
}

#[test]
fn a_reply_to_a_message_we_never_sent_is_refused() {
    let mut other = reply();
    other.responds_to = "msg-someone-elses".into();
    let body = serde_json::to_string(&other).unwrap();
    let ts = now().timestamp();
    assert_eq!(
        verify_callback(SECRET, &header(ts, &body), &body, &other, &expected(ts)),
        Err(VerifyError::UnknownIntent)
    );
}

#[test]
fn the_signature_is_checked_before_anything_the_reply_claims() {
    // An unsigned request must not learn, from the shape of the refusal,
    // whether a given message_id exists.
    let mut other = reply();
    other.responds_to = "msg-probe".into();
    let body = serde_json::to_string(&other).unwrap();
    assert_eq!(
        verify_callback(
            SECRET,
            "t=1756598400,v1=bm90LWEtc2lnbmF0dXJl",
            &body,
            &other,
            &expected(now().timestamp())
        ),
        Err(VerifyError::BadSignature)
    );
}

#[test]
fn a_redelivered_callback_is_applied_once() {
    let body = serde_json::to_string(&reply()).unwrap();
    let ts = now().timestamp();
    let mut seen = expected(ts);
    seen.already_applied = true;
    assert_eq!(
        verify_callback(SECRET, &header(ts, &body), &body, &reply(), &seen),
        Err(VerifyError::Duplicate)
    );
}

#[test]
fn a_malformed_signature_header_is_refused_rather_than_guessed() {
    let body = serde_json::to_string(&reply()).unwrap();
    for bad in ["", "v1=abc", "t=notanumber,v1=abc", "garbage"] {
        assert_eq!(
            verify_callback(SECRET, bad, &body, &reply(), &expected(now().timestamp())),
            Err(VerifyError::MalformedHeader),
            "{bad}"
        );
    }
}

#[test]
fn a_secret_without_the_prefix_is_unusable() {
    assert_eq!(
        opensesame_a2h::sign("YWJjZA==", 0, "{}"),
        Err(VerifyError::UnusableSecret)
    );
}
