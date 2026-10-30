use super::*;
use crate::keys;
use crate::types::KeyAlgorithm;

#[test]
fn every_algorithm_signs_and_verifies_its_own_message() {
    for algorithm in [
        KeyAlgorithm::EcdsaP256,
        KeyAlgorithm::EcdsaP384,
        KeyAlgorithm::Ed25519,
        KeyAlgorithm::Rsa2048,
    ] {
        let key = keys::generate(algorithm).unwrap();
        let signer = SealedKeySigner::new(&key).unwrap();
        let signature = signer.sign(b"authorize this").unwrap();
        assert_eq!(signer.algorithm(), algorithm.default_signature_algorithm());
        verify(
            signer.algorithm(),
            &signer.public_key_der(),
            b"authorize this",
            &signature,
        )
        .unwrap();
    }
}

#[test]
fn a_tampered_message_or_signature_fails_verification() {
    let key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
    let signer = SealedKeySigner::new(&key).unwrap();
    let signature = signer.sign(b"original").unwrap();
    assert_eq!(
        verify(
            signer.algorithm(),
            &signer.public_key_der(),
            b"tampered",
            &signature
        )
        .unwrap_err(),
        PkiError::SignatureInvalid
    );
    let mut broken = signature.clone();
    let last = broken.len() - 1;
    broken[last] ^= 0xff;
    assert!(verify(
        signer.algorithm(),
        &signer.public_key_der(),
        b"original",
        &broken
    )
    .is_err());
}

#[test]
fn rsa_signs_under_each_permitted_digest() {
    for key_algorithm in [KeyAlgorithm::Rsa2048, KeyAlgorithm::Rsa4096] {
        let original = keys::generate(key_algorithm).unwrap();
        let key = keys::from_pkcs8_pem(&original.private_key_pkcs8_pem(), key_algorithm).unwrap();
        assert_eq!(key.public_key_der(), original.public_key_der());
        let wrong_key = keys::generate(key_algorithm).unwrap();
        for algorithm in [
            SignatureAlgorithm::Sha256Rsa,
            SignatureAlgorithm::Sha384Rsa,
            SignatureAlgorithm::Sha512Rsa,
        ] {
            let signer = SealedKeySigner::with_algorithm(&key, algorithm).unwrap();
            let public = signer.public_key_der();
            let signature = signer.sign(b"payload").unwrap();
            verify(algorithm, &public, b"payload", &signature).unwrap();
            assert_eq!(
                verify(algorithm, &public, b"changed", &signature),
                Err(PkiError::SignatureInvalid)
            );
            assert_eq!(
                verify(
                    algorithm,
                    &wrong_key.public_key_der(),
                    b"payload",
                    &signature
                ),
                Err(PkiError::SignatureInvalid)
            );
            for hostile in [
                vec![],
                vec![0],
                vec![0xff; signature.len()],
                signature[..signature.len() - 1].to_vec(),
            ] {
                assert_eq!(
                    verify(algorithm, &public, b"payload", &hostile),
                    Err(PkiError::SignatureInvalid)
                );
            }
            assert_eq!(
                verify(algorithm, b"not SPKI", b"payload", &signature),
                Err(PkiError::InvalidDer)
            );
            let wrong_shape = keys::generate(KeyAlgorithm::Ed25519).unwrap();
            assert_eq!(
                verify(
                    algorithm,
                    &wrong_shape.public_key_der(),
                    b"payload",
                    &signature
                ),
                Err(PkiError::InvalidDer)
            );
        }
    }
}

#[test]
fn a_key_cannot_be_asked_for_an_algorithm_it_cannot_produce() {
    let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
    assert_eq!(
        SealedKeySigner::with_algorithm(&key, SignatureAlgorithm::Sha256Rsa).unwrap_err(),
        PkiError::UnsupportedAlgorithm
    );
    let ecdsa = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
    assert_eq!(
        SealedKeySigner::with_algorithm(&ecdsa, SignatureAlgorithm::Sha384Ecdsa).unwrap_err(),
        PkiError::UnsupportedAlgorithm
    );
}

#[test]
fn verification_rejects_a_public_key_of_the_wrong_shape() {
    let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
    let signer = SealedKeySigner::new(&key).unwrap();
    let signature = signer.sign(b"x").unwrap();
    assert_eq!(
        verify(SignatureAlgorithm::Ed25519, b"", b"x", &signature).unwrap_err(),
        PkiError::InvalidDer
    );
    assert_eq!(
        verify(
            SignatureAlgorithm::Sha256Ecdsa,
            &signer.public_key_der(),
            b"x",
            &signature
        )
        .unwrap_err(),
        PkiError::InvalidDer
    );
}

#[test]
fn debug_never_renders_private_material() {
    let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
    let signer = SealedKeySigner::new(&key).unwrap();
    assert_eq!(
        format!("{signer:?}"),
        "SealedKeySigner { algorithm: Ed25519, private: \"<redacted>\" }"
    );
}

#[test]
fn the_trait_is_object_safe_so_custody_can_vary_at_runtime() {
    let key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
    let signer: Box<dyn Signer> = Box::new(SealedKeySigner::new(&key).unwrap());
    let signature = signer.sign(b"dynamic").unwrap();
    verify(
        signer.algorithm(),
        &signer.public_key_der(),
        b"dynamic",
        &signature,
    )
    .unwrap();
}

#[test]
fn rsa_spki_requires_explicit_null_algorithm_parameters() {
    use der::{Decode as _, Encode as _};

    let key = keys::generate(KeyAlgorithm::Rsa2048).unwrap();
    let public = key.public_key_der();
    let parsed = spki::SubjectPublicKeyInfoRef::from_der(&public).unwrap();
    for parameters in [
        None,
        Some(der::asn1::AnyRef::new(der::Tag::OctetString, &[]).unwrap()),
    ] {
        let malformed = spki::SubjectPublicKeyInfoRef {
            algorithm: spki::AlgorithmIdentifierRef {
                oid: parsed.algorithm.oid,
                parameters,
            },
            subject_public_key: parsed.subject_public_key,
        }
        .to_der()
        .unwrap();
        assert_eq!(
            verify(SignatureAlgorithm::Sha256Rsa, &malformed, b"payload", &[]),
            Err(PkiError::InvalidDer)
        );
    }
}

#[test]
fn rsa_private_pkcs8_rejects_missing_or_non_null_algorithm_parameters() {
    let key = keys::generate(KeyAlgorithm::Rsa2048).unwrap();
    let pem = key.private_key_pkcs8_pem();
    let (_, document) = pkcs8::SecretDocument::from_pem(&pem).unwrap();
    let mut info: pkcs8::PrivateKeyInfoRef<'_> = document.decode_msg().unwrap();
    for parameters in [
        None,
        Some(
            pkcs8::der::asn1::AnyRef::new(pkcs8::der::Tag::OctetString, &[]).unwrap(),
        ),
    ] {
        info.algorithm.parameters = parameters;
        let malformed = pkcs8::SecretDocument::encode_msg(&info).unwrap();
        let pem = malformed
            .to_pem("PRIVATE KEY", pkcs8::LineEnding::LF)
            .unwrap();
        assert!(matches!(
            keys::from_pkcs8_pem(&pem, KeyAlgorithm::Rsa2048),
            Err(PkiError::InvalidPem)
        ));
    }
}

// RFC 6979 Appendix A.2.5, P-256/SHA-256 "sample". Its high-S value is
// deliberately retained: existing X.509 ECDSA signatures need not be low-S.
#[test]
fn verifies_existing_rfc6979_high_s_der_signature() {
    let public_key = hex::decode(concat!(
        "3059301306072a8648ce3d020106082a8648ce3d03010703420004",
        "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6",
        "7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299"
    ))
    .unwrap();
    let signature = hex::decode(concat!(
        "3046022100",
        "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716",
        "022100",
        "f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8"
    ))
    .unwrap();
    verify(
        SignatureAlgorithm::Sha256Ecdsa,
        &public_key,
        b"sample",
        &signature,
    )
    .unwrap();
    assert_eq!(
        verify(
            SignatureAlgorithm::Sha256Ecdsa,
            &public_key,
            b"tampered",
            &signature
        ),
        Err(PkiError::SignatureInvalid)
    );
}

#[test]
fn ed25519_pkcs8_round_trip_and_invalid_inputs_fail_closed() {
    let original = keys::generate(KeyAlgorithm::Ed25519).unwrap();
    let pem = original.private_key_pkcs8_pem();
    let reloaded = keys::from_pkcs8_pem(&pem, KeyAlgorithm::Ed25519).unwrap();
    assert_eq!(reloaded.public_key_der(), original.public_key_der());
    let signer = SealedKeySigner::new(&reloaded).unwrap();
    let public = signer.public_key_der();
    let signature = signer.sign(b"authorize this").unwrap();
    verify(
        SignatureAlgorithm::Ed25519,
        &public,
        b"authorize this",
        &signature,
    )
    .unwrap();
    assert_eq!(
        verify(
            SignatureAlgorithm::Ed25519,
            &public,
            b"tampered",
            &signature
        ),
        Err(PkiError::SignatureInvalid)
    );
    let mut corrupted = signature.clone();
    corrupted[0] ^= 1;
    assert_eq!(
        verify(
            SignatureAlgorithm::Ed25519,
            &public,
            b"authorize this",
            &corrupted
        ),
        Err(PkiError::SignatureInvalid)
    );
    assert_eq!(
        verify(
            SignatureAlgorithm::Ed25519,
            b"not SPKI",
            b"authorize this",
            &signature
        ),
        Err(PkiError::InvalidDer)
    );
    assert!(matches!(
        keys::from_pkcs8_pem("not PKCS8", KeyAlgorithm::Ed25519),
        Err(PkiError::InvalidPem)
    ));
}
