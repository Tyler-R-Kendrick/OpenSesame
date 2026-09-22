#![no_main]

//! NATS auth-callout envelope decoding (ADR 0130).
//!
//! The bridge forwards a server-signed `$SYS.REQ.USER.AUTH` request and the
//! Host re-verifies it against the operator's pinned server nkeys. Both the
//! JSON envelope the bridge posts and the JWT inside it are
//! attacker-influenced, so decoding must be total over arbitrary text and an
//! envelope must never verify against a server key that did not sign it.
//!
//! Note the boundary this does *not* test: `Expectations::server_public_keys`
//! being empty means "any well-formed server key" at the crate level. The
//! fail-closed pin check lives in the Host route
//! (`apps/gateway/src/routes/nats_callout_verify.rs::verify_request`), which
//! refuses outright when the list is empty.

use libfuzzer_sys::fuzz_target;
use opensesame_nats_callout::host_client::HostDecisionRequest;
use opensesame_nats_callout::{decode_request, CalloutError, Expectations};

/// A well-formed server nkey that signed nothing in this corpus.
const UNRELATED_SERVER: &str = "NDGKXQZ5YQDXFKSKPTF6LVJMAYUYJUKCBBTZCZ6FLAK7C6LDHWZP2LKL";

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let expect = Expectations {
        server_public_keys: vec![UNRELATED_SERVER.to_owned()],
        callout_subject: Some("account-under-test".to_owned()),
        now: 1_700_000_000,
    };
    match decode_request(text, &expect) {
        Ok(verified) => panic!(
            "an arbitrary envelope verified against an unrelated key: {}",
            verified.claims.nats.user_nkey
        ),
        Err(CalloutError::SigningFailed) => panic!("signing error on a decode path"),
        Err(_) => {}
    }
    // The outer JSON envelope must decode or be refused, never panic, and
    // `deny_unknown_fields` must keep an unexpected field out.
    if let Ok(body) = serde_json::from_str::<HostDecisionRequest>(text) {
        assert!(body.request_digest.len() <= 4096);
        assert!(body.user_nkey.len() <= 4096);
    }
});
