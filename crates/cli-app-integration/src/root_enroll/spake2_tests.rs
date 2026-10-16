//! RFC 9382 P-256 vectors and the checks around them.

use serde::Deserialize;

use super::{evaluate, random_scalar, scalar_from_bytes, shared_k_from_a, RootEnrollError};

const VECTORS: &str = include_str!("../../../../spec/conformance/cli-root-enroll-pake.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorFile {
    rfc9382: Vec<RfcCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RfcCase {
    id: String,
    a: String,
    b: String,
    w: String,
    x: String,
    y: String,
    p_a: String,
    p_b: String,
    k: String,
    ke: String,
    ka: String,
    kc_a: String,
    kc_b: String,
    c_a: String,
    c_b: String,
}

fn unhex<const N: usize>(value: &str) -> [u8; N] {
    let bytes = hex::decode(value).expect("hex");
    let len = bytes.len();
    bytes
        .try_into()
        .unwrap_or_else(|_| panic!("expected {N} bytes, got {len}"))
}

fn scalar_of(value: &str) -> p256::Scalar {
    scalar_from_bytes(&unhex(value)).expect("canonical non-zero scalar")
}

#[test]
fn rfc9382_p256_vectors_match() {
    let file: VectorFile = serde_json::from_str(VECTORS).expect("pake vectors");
    assert_eq!(file.rfc9382.len(), 4);
    for case in file.rfc9382 {
        let transcript = evaluate(
            case.a.as_bytes(),
            case.b.as_bytes(),
            &scalar_of(&case.w),
            &scalar_of(&case.x),
            &scalar_of(&case.y),
            b"",
        )
        .unwrap_or_else(|_| panic!("evaluate {}", case.id));
        assert_eq!(hex::encode(transcript.p_a), case.p_a, "{}", case.id);
        assert_eq!(hex::encode(transcript.p_b), case.p_b, "{}", case.id);
        assert_eq!(hex::encode(transcript.k), case.k, "{}", case.id);
        assert_eq!(hex::encode(transcript.ke), case.ke, "{}", case.id);
        assert_eq!(hex::encode(transcript.ka), case.ka, "{}", case.id);
        assert_eq!(hex::encode(transcript.kc_a), case.kc_a, "{}", case.id);
        assert_eq!(hex::encode(transcript.kc_b), case.kc_b, "{}", case.id);
        assert_eq!(hex::encode(transcript.c_a), case.c_a, "{}", case.id);
        assert_eq!(hex::encode(transcript.c_b), case.c_b, "{}", case.id);
    }
}

#[test]
fn both_sides_agree_and_associated_data_changes_only_the_confirmation() {
    let w = random_scalar();
    let x = random_scalar();
    let y = random_scalar();
    let first = evaluate(b"client", b"daemon", &w, &x, &y, b"aad").expect("agree");
    let second = evaluate(b"client", b"daemon", &w, &x, &y, b"other").expect("aad");
    assert_eq!(first.p_a, second.p_a);
    assert_eq!(first.p_b, second.p_b);
    assert_eq!(first.k, second.k);
    assert_ne!(first.c_a, second.c_a);
    assert_ne!(first.c_b, second.c_b);
}

#[test]
fn rejects_a_different_password_and_a_damaged_point() {
    let w = random_scalar();
    let other = random_scalar();
    let x = random_scalar();
    let y = random_scalar();
    let good = evaluate(b"a", b"b", &w, &x, &y, b"").expect("baseline");
    let err = shared_k_from_a(&other, &x, &good.p_b).expect("different password still a point");
    assert_ne!(err, good.k);

    let mut damaged = good.p_b;
    damaged[64] ^= 0x01;
    assert_eq!(
        shared_k_from_a(&w, &x, &damaged).unwrap_err(),
        RootEnrollError::InvalidMessage
    );
    let mut identity = [0u8; 65];
    identity[0] = 0x04;
    assert_eq!(
        shared_k_from_a(&w, &x, &identity).unwrap_err(),
        RootEnrollError::InvalidMessage
    );
    let mut tagged = good.p_b;
    tagged[0] = 0x02;
    assert_eq!(
        shared_k_from_a(&w, &x, &tagged).unwrap_err(),
        RootEnrollError::InvalidMessage
    );
}

#[test]
fn scalar_from_bytes_rejects_zero_and_non_canonical() {
    assert!(scalar_from_bytes(&[0u8; 32]).is_none());
    let mut over = [0xffu8; 32];
    over[31] = 0xff;
    assert!(scalar_from_bytes(&over).is_none());
}
