//! RFC 9180 base mode against `spec/conformance/hpke-rfc9180-vectors.json`, the
//! file the TypeScript reader also reads: Appendix A.1 (AES-128-GCM) and A.2
//! (ChaCha20-Poly1305), every intermediate value.

use opensesame_quorum_recovery::hpke::{
    derive_key_pair, open_base, seal_base, setup_base_recipient, setup_base_sender, HpkeAead,
    HpkeError,
};
use rand::{rngs::StdRng, SeedableRng};
use serde::Deserialize;

const VECTORS: &str = include_str!("../../../spec/conformance/hpke-rfc9180-vectors.json");

#[derive(Deserialize)]
struct File {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    aead_id: String,
    info: String,
    #[serde(rename = "ikmE")]
    ikm_e: String,
    #[serde(rename = "pkEm")]
    pk_em: String,
    #[serde(rename = "skEm")]
    sk_em: String,
    #[serde(rename = "ikmR")]
    ikm_r: String,
    #[serde(rename = "pkRm")]
    pk_rm: String,
    #[serde(rename = "skRm")]
    sk_rm: String,
    enc: String,
    shared_secret: String,
    key: String,
    base_nonce: String,
    exporter_secret: String,
    encryptions: Vec<Encryption>,
    exports: Vec<Export>,
}

#[derive(Deserialize)]
struct Encryption {
    seq: u64,
    pt: String,
    aad: String,
    nonce: String,
    ct: String,
}

#[derive(Deserialize)]
struct Export {
    exporter_context: String,
    #[serde(rename = "L")]
    length: String,
    exported_value: String,
}

fn vectors() -> Vec<Vector> {
    serde_json::from_str::<File>(VECTORS).unwrap().vectors
}

fn bytes(text: &str) -> Vec<u8> {
    hex::decode(text).unwrap()
}

fn aead_of(v: &Vector) -> HpkeAead {
    HpkeAead::from_id(v.aead_id.parse().unwrap()).unwrap()
}

#[test]
fn carries_both_x25519_suites_the_module_implements() {
    let ids: Vec<String> = vectors().into_iter().map(|v| v.aead_id).collect();
    assert_eq!(ids, ["1", "3"]);
}

#[test]
fn derives_the_published_key_pairs_from_their_ikm() {
    for v in vectors() {
        let e = derive_key_pair(&bytes(&v.ikm_e)).unwrap();
        assert_eq!(hex::encode(e.secret_key.expose()), v.sk_em, "{}", v.name);
        assert_eq!(hex::encode(e.public_key), v.pk_em, "{}", v.name);
        let r = derive_key_pair(&bytes(&v.ikm_r)).unwrap();
        assert_eq!(hex::encode(r.secret_key.expose()), v.sk_rm, "{}", v.name);
        assert_eq!(hex::encode(r.public_key), v.pk_rm, "{}", v.name);
    }
}

#[test]
fn reproduces_enc_the_shared_secret_and_the_key_schedule_on_both_sides() {
    for v in vectors() {
        let aead = aead_of(&v);
        let ephemeral = derive_key_pair(&bytes(&v.ikm_e)).unwrap();
        let (enc, sender) =
            setup_base_sender(&bytes(&v.pk_rm), &bytes(&v.info), aead, &ephemeral).unwrap();
        let recipient =
            setup_base_recipient(&bytes(&v.enc), &bytes(&v.sk_rm), &bytes(&v.info), aead).unwrap();
        assert_eq!(hex::encode(&enc), v.enc, "{}", v.name);
        for side in [&sender, &recipient] {
            assert_eq!(hex::encode(side.shared_secret()), v.shared_secret);
            assert_eq!(hex::encode(side.key()), v.key);
            assert_eq!(hex::encode(side.base_nonce()), v.base_nonce);
            assert_eq!(hex::encode(side.exporter_secret()), v.exporter_secret);
        }
    }
}

#[test]
fn derives_the_published_nonce_for_every_sequence_number() {
    for v in vectors() {
        let context = setup_base_recipient(
            &bytes(&v.enc),
            &bytes(&v.sk_rm),
            &bytes(&v.info),
            aead_of(&v),
        )
        .unwrap();
        for e in &v.encryptions {
            assert_eq!(
                hex::encode(context.nonce_at(e.seq)),
                e.nonce,
                "{} seq {}",
                v.name,
                e.seq
            );
        }
    }
}

/// The RFC prints sequence numbers 0, 1, 2, 4, 255 and 256. A context has one
/// counter, so seal and open every message up to 256 in order and compare the
/// ciphertext wherever the RFC prints one.
#[test]
fn seals_the_published_ciphertexts_in_order_and_opens_them() {
    for v in vectors() {
        let suite = aead_of(&v);
        let ephemeral = derive_key_pair(&bytes(&v.ikm_e)).unwrap();
        let (_, mut sender) =
            setup_base_sender(&bytes(&v.pk_rm), &bytes(&v.info), suite, &ephemeral).unwrap();
        let mut recipient =
            setup_base_recipient(&bytes(&v.enc), &bytes(&v.sk_rm), &bytes(&v.info), suite).unwrap();
        let fallback = bytes(&v.encryptions[0].pt);
        for seq in 0..=256_u64 {
            let printed: Option<&Encryption> = v.encryptions.iter().find(|e| e.seq == seq);
            let plaintext = printed.map_or_else(|| fallback.clone(), |e| bytes(&e.pt));
            let aad = printed.map_or_else(|| vec![0], |e| bytes(&e.aad));
            let sealed = sender.seal(&aad, &plaintext).unwrap();
            if let Some(e) = printed {
                assert_eq!(hex::encode(&sealed), e.ct, "{} seq {seq}", v.name);
            }
            assert_eq!(recipient.open(&aad, &sealed).unwrap(), plaintext);
        }
    }
}

#[test]
fn exports_the_published_secrets() {
    for v in vectors() {
        let context = setup_base_recipient(
            &bytes(&v.enc),
            &bytes(&v.sk_rm),
            &bytes(&v.info),
            aead_of(&v),
        )
        .unwrap();
        for e in &v.exports {
            let exported = context
                .export(&bytes(&e.exporter_context), e.length.parse().unwrap())
                .unwrap();
            assert_eq!(
                hex::encode(exported.expose()),
                e.exported_value,
                "{}",
                v.name
            );
        }
    }
}

mod single_shot {
    use super::*;

    fn recipient() -> opensesame_quorum_recovery::hpke::KeyPair {
        let mut rng = StdRng::seed_from_u64(11);
        opensesame_quorum_recovery::hpke::generate_key_pair(&mut rng)
    }

    const INFO: &[u8] = b"opensesame/test";
    const AAD: &[u8] = b"request-digest";
    const PLAINTEXT: &[u8] = b"a share, as 33 words";

    fn sealed(aead: HpkeAead) -> (opensesame_quorum_recovery::hpke::KeyPair, Vec<u8>, Vec<u8>) {
        let r = recipient();
        let mut rng = StdRng::seed_from_u64(12);
        let (enc, ct) = seal_base(&mut rng, &r.public_key, INFO, AAD, PLAINTEXT, aead).unwrap();
        (r, enc, ct)
    }

    #[test]
    fn round_trips_with_both_aeads() {
        for aead in [HpkeAead::Aes128Gcm, HpkeAead::ChaCha20Poly1305] {
            let (r, enc, ct) = sealed(aead);
            let opened = open_base(r.secret_key.expose(), &enc, INFO, AAD, &ct, aead).unwrap();
            assert_eq!(opened.expose(), PLAINTEXT);
        }
    }

    #[test]
    fn opens_for_no_one_but_the_named_recipient_and_no_other_context() {
        let (r, enc, ct) = sealed(HpkeAead::Aes128Gcm);
        let other = derive_key_pair(&[9; 32]).unwrap();
        let aead = HpkeAead::Aes128Gcm;
        let open =
            |sk: &[u8], info: &[u8], aad: &[u8], aead| open_base(sk, &enc, info, aad, &ct, aead);
        assert_eq!(
            open(other.secret_key.expose(), INFO, AAD, aead).unwrap_err(),
            HpkeError::Authentication
        );
        assert!(open(r.secret_key.expose(), b"other", AAD, aead).is_err());
        assert!(open(r.secret_key.expose(), INFO, b"another", aead).is_err());
        assert!(open(r.secret_key.expose(), INFO, AAD, HpkeAead::ChaCha20Poly1305).is_err());
    }

    #[test]
    fn a_flipped_bit_does_not_authenticate() {
        let (r, enc, mut ct) = sealed(HpkeAead::Aes128Gcm);
        ct[0] ^= 1;
        assert_eq!(
            open_base(
                r.secret_key.expose(),
                &enc,
                INFO,
                AAD,
                &ct,
                HpkeAead::Aes128Gcm
            )
            .unwrap_err(),
            HpkeError::Authentication
        );
    }

    #[test]
    fn a_low_order_public_key_is_refused() {
        let mut rng = StdRng::seed_from_u64(13);
        assert_eq!(
            seal_base(
                &mut rng,
                &[0; 32],
                INFO,
                AAD,
                PLAINTEXT,
                HpkeAead::Aes128Gcm
            )
            .unwrap_err(),
            HpkeError::LowOrderPoint
        );
        assert_eq!(
            seal_base(
                &mut rng,
                &[1; 31],
                INFO,
                AAD,
                PLAINTEXT,
                HpkeAead::Aes128Gcm
            )
            .unwrap_err(),
            HpkeError::KeyLength
        );
    }

    #[test]
    fn uses_a_fresh_ephemeral_key_for_every_seal() {
        let r = recipient();
        let mut rng = StdRng::seed_from_u64(14);
        let seal = |rng: &mut StdRng| {
            seal_base(
                rng,
                &r.public_key,
                INFO,
                AAD,
                PLAINTEXT,
                HpkeAead::Aes128Gcm,
            )
            .unwrap()
            .0
        };
        assert_ne!(seal(&mut rng), seal(&mut rng));
    }
}
