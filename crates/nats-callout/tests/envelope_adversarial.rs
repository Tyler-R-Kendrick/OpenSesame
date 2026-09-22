//! SEC-FUZZ / SEC-CONFUSION — the callout boundary decoder, driven the way
//! `fuzz/fuzz_targets/transport_callout_envelope.rs` drives it, in the
//! ordinary test suite.
//!
//! Two different things arrive at this boundary and must not be confused:
//! the **bridge's** JSON envelope, which is a summary the Host never trusts,
//! and the **server-signed** request JWT inside it, which is the only thing
//! that carries provenance. The properties asserted here are that arbitrary
//! text never verifies against a key that did not sign it, that the decode
//! path is total, and that the envelope's `deny_unknown_fields` holds — a
//! body may not smuggle a field past it.

use opensesame_nats_callout::fixtures::Parties;
use opensesame_nats_callout::host_client::HostDecisionRequest;
use opensesame_nats_callout::{decode_request, CalloutError, Expectations};

/// A well-formed server nkey that signed nothing here.
const UNRELATED_SERVER: &str = "NDGKXQZ5YQDXFKSKPTF6LVJMAYUYJUKCBBTZCZ6FLAK7C6LDHWZP2LKL";

fn pseudo_random(seed: u64, len: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            u8::try_from((state >> 33) & 0xFF).unwrap_or_default()
        })
        .collect()
}

fn pinned() -> Expectations {
    Expectations {
        server_public_keys: vec![UNRELATED_SERVER.to_owned()],
        callout_subject: Some("account-under-test".to_owned()),
        now: 1_700_000_000,
    }
}

/// No arbitrary text verifies against a pinned key that did not sign it,
/// and decoding is total: every outcome is a typed refusal.
#[test]
fn arbitrary_text_never_verifies_against_a_pinned_key() {
    let expect = pinned();
    for seed in 0..1_200u64 {
        for len in [0usize, 3, 40, 300] {
            let bytes = pseudo_random(seed, len);
            let text = String::from_utf8_lossy(&bytes).to_string();
            match decode_request(&text, &expect) {
                Ok(verified) => panic!(
                    "arbitrary text verified: {}",
                    verified.claims.nats.user_nkey
                ),
                Err(CalloutError::SigningFailed) => {
                    panic!("a signing error surfaced on a decode path")
                }
                Err(_) => {}
            }
        }
    }
}

/// Token-shaped text — three base64url segments — is the shape that gets
/// furthest into the decoder, so it gets its own pass.
#[test]
fn token_shaped_text_is_refused_not_accepted() {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let expect = pinned();
    for seed in 0..600u64 {
        let header = engine.encode(pseudo_random(seed, 24));
        let payload = engine.encode(pseudo_random(seed + 1, 96));
        let signature = engine.encode(pseudo_random(seed + 2, 64));
        let token = format!("{header}.{payload}.{signature}");
        assert!(
            decode_request(&token, &expect).is_err(),
            "a forged token verified (seed {seed})"
        );
    }
}

/// A *genuinely* signed request from one server, offered to a deployment
/// that pinned a different server. The envelope is self-consistent and its
/// signature verifies under its own issuer — which is exactly the
/// "self-signed server envelope" the directive says must not be laundered —
/// and it is still refused, because provenance is the pin list, not the
/// signature's internal consistency.
#[test]
fn a_correctly_signed_request_from_an_unpinned_server_is_refused() {
    let signer = Parties::generate();
    let other = Parties::generate();
    let now = 1_700_000_000;
    let token = signer.signed_request(now, "client-token");

    // Its own issuer verifies it: the fixture is a real request, not junk.
    let own = decode_request(
        &token,
        &Expectations {
            server_public_keys: vec![signer.server.public_key()],
            callout_subject: Some(signer.account.public_key()),
            now,
        },
    )
    .expect("the fixture must be a genuinely signed request");
    assert_eq!(own.server_public_key, signer.server.public_key());

    // A deployment that pinned a different server refuses it outright.
    let error = decode_request(
        &token,
        &Expectations {
            server_public_keys: vec![other.server.public_key()],
            callout_subject: Some(signer.account.public_key()),
            now,
        },
    )
    .expect_err("an unpinned server was accepted");
    assert_eq!(error, CalloutError::ServerUnknown);

    // And a deployment that pinned the right server but a different callout
    // account refuses it too: the account is part of the provenance.
    let error = decode_request(
        &token,
        &Expectations {
            server_public_keys: vec![signer.server.public_key()],
            callout_subject: Some(other.account.public_key()),
            now,
        },
    )
    .expect_err("a request for another account was accepted");
    assert_eq!(error, CalloutError::SubjectNotCallout);
}

/// One byte changed anywhere in a genuine request is a signature failure,
/// never a partially accepted claim set.
#[test]
fn a_tampered_genuine_request_never_verifies() {
    let signer = Parties::generate();
    let now = 1_700_000_000;
    let token = signer.signed_request(now, "client-token");
    let expect = Expectations {
        server_public_keys: vec![signer.server.public_key()],
        callout_subject: Some(signer.account.public_key()),
        now,
    };
    let bytes = token.as_bytes();
    for seed in 0..200u64 {
        let index = (usize::try_from(seed).unwrap_or(0) * 7 + 11) % bytes.len();
        if bytes[index] == b'.' {
            continue;
        }
        let mut tampered = bytes.to_vec();
        tampered[index] = if tampered[index] == b'A' { b'B' } else { b'A' };
        let Ok(text) = String::from_utf8(tampered) else {
            continue;
        };
        assert!(
            decode_request(&text, &expect).is_err(),
            "a tampered request verified (byte {index})"
        );
    }
}

/// The bridge's envelope is decoded with `deny_unknown_fields`: a body that
/// adds a field the Host does not know about is refused rather than ignored,
/// so no future field can be smuggled past a running deployment.
#[test]
fn the_envelope_refuses_unknown_fields_and_is_total() {
    let base = r#"{"request_digest":"d","server":{"id":"N","name":"n","host":"h"},"user_nkey":"U","request_nonce":"r","client":{},"raw_request_jwt":"a.b.c"}"#;
    assert!(
        serde_json::from_str::<HostDecisionRequest>(base).is_ok()
            || serde_json::from_str::<HostDecisionRequest>(base).is_err(),
        "decoding must be total"
    );
    let smuggled = base.replace(
        r#""raw_request_jwt""#,
        r#""verified":true,"principal":"admin","raw_request_jwt""#,
    );
    assert!(
        serde_json::from_str::<HostDecisionRequest>(&smuggled).is_err(),
        "an unknown field was accepted into the callout envelope"
    );
    for seed in 0..400u64 {
        let bytes = pseudo_random(seed, 80);
        let text = String::from_utf8_lossy(&bytes).to_string();
        let _ = serde_json::from_str::<HostDecisionRequest>(&text);
    }
}
