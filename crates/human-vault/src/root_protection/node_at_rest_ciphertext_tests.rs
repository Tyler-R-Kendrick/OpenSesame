//! Genuine XChaCha/HKDF/tag controls, not Node interoperability or retained-State authority proof.
use super::*;
fn fixture(legacy: bool, payload: &[u8]) -> Vec<u8> {
    let key = [31u8; 32];
    let name = "original-record.json";
    let bytes = if legacy {
        let nonce = [41u8; 24];
        let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
        let binding = format!("opensesame.at-rest.v1\0origin-file\0{name}");
        let mut bytes = nonce.to_vec();
        bytes.extend(
            cipher
                .encrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: payload,
                        aad: binding.as_bytes(),
                    },
                )
                .unwrap(),
        );
        bytes
    } else {
        // Independently construct the documented original Node envelope with actual crypto.
        let binding = serde_json::to_vec(&["opensesame.at-rest.v2", "origin-file", name]).unwrap();
        let mut wrapping_secret = [0u8; 32];
        Hkdf::<Sha256>::new(Some(b"opensesame.at-rest.v2.kek"), &key)
            .expand(&binding, &mut wrapping_secret)
            .unwrap();
        let dek = [71u8; 32];
        let wrap_nonce = [51u8; 24];
        let nonce = [61u8; 24];
        let wrap_aad =
            serde_json::to_vec(&["osr2", "wrap", &URL_SAFE_NO_PAD.encode(&binding)]).unwrap();
        let data_aad =
            serde_json::to_vec(&["osr2", "data", &URL_SAFE_NO_PAD.encode(&binding)]).unwrap();
        let wrapper = XChaCha20Poly1305::new_from_slice(&wrapping_secret).unwrap();
        let cipher = XChaCha20Poly1305::new_from_slice(&dek).unwrap();
        let mut bytes = wrap_nonce.to_vec();
        bytes.extend(
            wrapper
                .encrypt(
                    XNonce::from_slice(&wrap_nonce),
                    Payload {
                        msg: &dek,
                        aad: &wrap_aad,
                    },
                )
                .unwrap(),
        );
        bytes.extend(nonce);
        bytes.extend(
            cipher
                .encrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: payload,
                        aad: &data_aad,
                    },
                )
                .unwrap(),
        );
        bytes
    };
    format!(
        "{}.{}",
        if legacy { "osr1" } else { "osr2" },
        URL_SAFE_NO_PAD.encode(bytes)
    )
    .into_bytes()
}
#[test]
fn actual_ciphertext_authenticates_only_exact_root_domain_name_and_tags() {
    for legacy in [false, true] {
        let wire = fixture(legacy, b"controlled synthetic encrypted payload");
        let valid = |key: &[u8], domain, name, bytes| {
            validate_node_at_rest_ciphertext(key, domain, name, bytes)
        };
        valid(
            &[31; 32],
            NodeAtRestDomain::OriginFile,
            "original-record.json",
            &wire,
        )
        .unwrap();
        assert!(valid(
            &[32; 32],
            NodeAtRestDomain::OriginFile,
            "original-record.json",
            &wire
        )
        .is_err());
        assert!(valid(
            &[31; 32],
            NodeAtRestDomain::DeviceRecord,
            "original-record.json",
            &wire
        )
        .is_err());
        assert!(valid(
            &[31; 32],
            NodeAtRestDomain::VaultGeneration,
            "original-record.json",
            &wire
        )
        .is_err());
        assert!(valid(
            &[31; 32],
            NodeAtRestDomain::OriginFile,
            "transplanted-record.json",
            &wire
        )
        .is_err());
        let text = std::str::from_utf8(&wire).unwrap();
        let (prefix, encoded) = text.split_once('.').unwrap();
        let mut damaged = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        *damaged.last_mut().unwrap() ^= 1;
        let changed = format!("{prefix}.{}", URL_SAFE_NO_PAD.encode(damaged));
        assert!(valid(
            &[31; 32],
            NodeAtRestDomain::OriginFile,
            "original-record.json",
            changed.as_bytes()
        )
        .is_err());
    }
}
#[test]
fn refuses_plaintext_noncanonical_wire_and_authenticated_non_utf8() {
    for wire in [b"plaintext".as_slice(), b"osr2.AA=", b"osr3.AA", b"osr2.AA"] {
        assert!(validate_node_at_rest_ciphertext(
            &[31; 32],
            NodeAtRestDomain::OriginFile,
            "original-record.json",
            wire
        )
        .is_err());
    }
    for legacy in [false, true] {
        let wire = fixture(legacy, &[0xff]);
        assert!(validate_node_at_rest_ciphertext(
            &[31; 32],
            NodeAtRestDomain::OriginFile,
            "original-record.json",
            &wire
        )
        .is_err());
    }
}
