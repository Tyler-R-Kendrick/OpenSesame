//! Certificate-bound tokens: A over A passes, A over B does not, and a
//! re-issued certificate on the same key does not inherit the old binding.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use opensesame_domain::transport::TransportError;

use super::proof::{require_certificate_binding, Confirmation};
use super::test_support::{forwarded, peer, plain_extensions, tls_extensions, THUMB_A, THUMB_B};

fn cnf_for(thumbprint_hex: &str) -> Confirmation {
    let bytes = (0..thumbprint_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&thumbprint_hex[i..i + 2], 16).expect("hex"))
        .collect::<Vec<_>>();
    Confirmation {
        x5t_s256: Some(URL_SAFE_NO_PAD.encode(bytes)),
        jkt: None,
    }
}

#[test]
fn the_claim_is_43_characters_of_base64url() {
    let cnf = cnf_for(THUMB_A);
    let value = cnf.x5t_s256.expect("claim");
    assert_eq!(value.len(), 43);
    assert!(value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
}

#[test]
fn a_token_bound_to_the_presented_certificate_passes() {
    let extensions = tls_extensions(&peer("client.test", THUMB_A, 1), 1);
    assert!(require_certificate_binding(Some(&cnf_for(THUMB_A)), &extensions).is_ok());
}

#[test]
fn a_token_bound_to_another_certificate_is_refused() {
    let extensions = tls_extensions(&peer("client.test", THUMB_A, 1), 1);
    assert_eq!(
        require_certificate_binding(Some(&cnf_for(THUMB_B)), &extensions),
        Err(TransportError::ProofMismatch)
    );
}

/// The claim digests the certificate, not the key: a re-issue on the same key
/// has a different thumbprint and does not satisfy the old token.
#[test]
fn a_reissued_certificate_does_not_inherit_the_binding() {
    let reissued = "cc00000000000000000000000000000000000000000000000000000000000003";
    let extensions = tls_extensions(&peer("client.test", reissued, 1), 1);
    assert_eq!(
        require_certificate_binding(Some(&cnf_for(THUMB_A)), &extensions),
        Err(TransportError::ProofMismatch)
    );
}

#[test]
fn a_bound_token_on_the_plain_listener_is_refused() {
    assert_eq!(
        require_certificate_binding(Some(&cnf_for(THUMB_A)), &plain_extensions()),
        Err(TransportError::ProofMismatch)
    );
    assert_eq!(
        require_certificate_binding(Some(&cnf_for(THUMB_A)), &axum::http::Extensions::new()),
        Err(TransportError::ProofMismatch)
    );
}

/// Behind a trusted ingress the binding is to the originating client, never
/// to the ingress's own leaf — otherwise every client of that ingress could
/// spend every bound token issued to it.
#[test]
fn behind_an_ingress_the_originating_certificate_binds() {
    let ingress = peer("edge.test", THUMB_A, 1);
    let evidence = forwarded("client.test", THUMB_B, &ingress);
    let mut extensions = tls_extensions(&ingress, 1);
    extensions.insert(opensesame_ingress_evidence::OriginatingPeerExtension(
        std::sync::Arc::new(evidence),
    ));
    assert!(require_certificate_binding(Some(&cnf_for(THUMB_B)), &extensions).is_ok());
    assert_eq!(
        require_certificate_binding(Some(&cnf_for(THUMB_A)), &extensions),
        Err(TransportError::ProofMismatch)
    );
}

#[test]
fn tokens_without_a_certificate_confirmation_are_unchanged() {
    let extensions = plain_extensions();
    assert!(require_certificate_binding(None, &extensions).is_ok());
    // A DPoP confirmation is a different profile and is not conflated with a
    // certificate thumbprint.
    let dpop = Confirmation {
        x5t_s256: None,
        jkt: Some("0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I".into()),
    };
    assert!(dpop.x5t_s256.is_none());
    assert!(require_certificate_binding(Some(&dpop), &extensions).is_ok());
}

#[test]
fn a_malformed_claim_never_passes() {
    let extensions = tls_extensions(&peer("client.test", THUMB_A, 1), 1);
    for value in ["", "not-base64url!", &"A".repeat(43), &"A".repeat(44)] {
        let cnf = Confirmation {
            x5t_s256: Some(value.to_owned()),
            jkt: None,
        };
        assert_eq!(
            require_certificate_binding(Some(&cnf), &extensions),
            Err(TransportError::ProofMismatch),
            "accepted {value:?}"
        );
    }
}

#[test]
fn the_claim_shape_matches_what_identity_mints() {
    let json = serde_json::json!({"x5t#S256": "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"});
    let parsed: Confirmation = serde_json::from_value(json).expect("parses");
    assert!(parsed.x5t_s256.is_some());
    // Unknown members are refused: a confirmation is a security claim.
    assert!(serde_json::from_value::<Confirmation>(
        serde_json::json!({"x5t#S256": "a", "x5t": "b"})
    )
    .is_err());
}
