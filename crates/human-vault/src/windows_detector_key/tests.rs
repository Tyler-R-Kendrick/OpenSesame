use super::*;

#[test]
fn current_user_detector_key_roundtrip_is_randomized_and_exact_purpose_bound() {
    let identity = uuid::Uuid::new_v4().to_string();
    let other = uuid::Uuid::new_v4().to_string();
    let key = [71_u8; 32];
    let sealed = seal(&identity, &key).unwrap();
    let next = seal(&identity, &key).unwrap();
    assert_ne!(sealed, next);
    assert_eq!(&open(&identity, &sealed).unwrap()[..], &key);
    assert!(open(&other, &sealed).is_err());
    assert!(sealed.starts_with(MAGIC));
    assert!(sealed.len() > key.len());
    assert!(!sealed.windows(key.len()).any(|part| part == key));
}

#[test]
fn dpapi_tampering_truncation_foreign_codecs_and_unknown_versions_fail_closed() {
    let identity = uuid::Uuid::new_v4().to_string();
    let sealed = seal(&identity, &[63_u8; 32]).unwrap();
    let mut tampered = sealed.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(open(&identity, &tampered).is_err());
    assert!(open(&identity, &sealed[..sealed.len() / 2]).is_err());
    assert!(open(&identity, &sealed[MAGIC.len()..]).is_err());
    let mut future = sealed;
    future[MAGIC.len() - 1] = 2;
    assert!(open(&identity, &future).is_err());
    assert!(open(&identity, &[0_u8; 32]).is_err());
    assert!(open(&identity, &vec![0_u8; MAX_SEALED_KEY_BYTES + 1]).is_err());
}

#[test]
fn bounded_key_codec_rejects_noncanonical_identity_and_wrong_key_lengths() {
    let identity = "f47517c0-5d4c-4559-a761-847cfad5ec5e".to_owned();
    let sealed = seal(&identity, &[1_u8; 32]).unwrap();
    for invalid in [
        identity.to_uppercase(),
        format!(" {identity}"),
        String::new(),
        "vendor-api-key".into(),
    ] {
        assert!(seal(&invalid, &[1_u8; 32]).is_err());
        assert!(open(&invalid, &sealed).is_err());
    }
    for length in [0, 31, 33, MAX_SEALED_KEY_BYTES + 1] {
        assert!(seal(&identity, &vec![0_u8; length]).is_err());
    }
}
