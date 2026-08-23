//! Committed golden crypto vectors for the Bitwarden key ladder.
//!
//! Two independent guarantees live here:
//!
//! 1. **Known-answer tests** against published vectors (RFC 7914 §11 for
//!    PBKDF2-HMAC-SHA256, RFC 5869 §A.2 for HKDF-Expand). These do not depend
//!    on this crate's own output, so they catch a broken primitive.
//! 2. **Self-generated golden vectors** (`tests/vectors/crypto_vectors.json`)
//!    that pin the *composition* — email normalization, the Argon2id
//!    SHA-256(email) salt, the `enc`/`mac` HKDF info strings, the master
//!    password hash construction, and the EncString wire form. Regenerate
//!    deliberately with `cargo test -p opensesame-provider-bitwarden
//!    --test crypto_vectors -- --ignored regenerate`; a diff in the committed
//!    file is a change to the vault format, not a test detail.
//!
//! Nothing here touches the network (C9). The slow, production-shaped
//! parameters (PBKDF2 600 000, Argon2id 64 MiB) are marked `slow` and run
//! only under `--ignored`, because a debug-profile suite cannot afford them.

use std::path::PathBuf;

use opensesame_provider_bitwarden::{EncString, Kdf, MasterKey, SymmetricKey};
use serde_json::{json, Value};

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(raw: &str) -> Vec<u8> {
    assert!(raw.len() % 2 == 0, "hex must be even length");
    (0..raw.len() / 2)
        .map(|i| u8::from_str_radix(&raw[i * 2..i * 2 + 2], 16).expect("hex digit"))
        .collect()
}

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/crypto_vectors.json")
}

fn load() -> Value {
    let path = vectors_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("vectors are valid JSON")
}

struct Case {
    name: String,
    slow: bool,
    email: String,
    master_password: String,
    kdf: Kdf,
    user_key_bytes: Vec<u8>,
    plaintext: String,
}

/// The vector definitions. The *expected* values live in the committed JSON;
/// these are only the inputs.
fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "pbkdf2-sha256-100000".into(),
            slow: false,
            email: "Vector-User@Example.COM".into(),
            master_password: "correct horse battery staple".into(),
            kdf: Kdf::Pbkdf2 {
                iterations: 100_000,
            },
            user_key_bytes: (0u8..64).map(|i| i.wrapping_mul(17).wrapping_add(2)).collect(),
            plaintext: "s3cr3t-vault-value".into(),
        },
        Case {
            name: "pbkdf2-sha256-600000-bitwarden-default".into(),
            slow: true,
            email: "vector-user@example.com".into(),
            master_password: "correct horse battery staple".into(),
            kdf: Kdf::Pbkdf2 {
                iterations: opensesame_provider_bitwarden::DEFAULT_PBKDF2_ITERATIONS,
            },
            user_key_bytes: (0u8..64).map(|i| i.wrapping_mul(19).wrapping_add(4)).collect(),
            plaintext: "s3cr3t-vault-value".into(),
        },
        Case {
            name: "argon2id-8mib-t2-p1".into(),
            slow: false,
            email: "argon-user@example.com".into(),
            master_password: "hunter2-hunter2-hunter2".into(),
            kdf: Kdf::argon2id(2, 8 * 1024, 1).expect("valid params"),
            user_key_bytes: (0u8..64).map(|i| i.wrapping_mul(23).wrapping_add(6)).collect(),
            plaintext: "argon-protected-value".into(),
        },
        Case {
            name: "argon2id-64mib-t3-p4-bitwarden-default".into(),
            slow: true,
            email: "argon-user@example.com".into(),
            master_password: "hunter2-hunter2-hunter2".into(),
            kdf: Kdf::argon2id(3, 64 * 1024, 4).expect("valid params"),
            user_key_bytes: (0u8..64).map(|i| i.wrapping_mul(29).wrapping_add(8)).collect(),
            plaintext: "argon-protected-value".into(),
        },
    ]
}

fn kdf_json(kdf: &Kdf) -> Value {
    match *kdf {
        Kdf::Pbkdf2 { iterations } => json!({ "type": "pbkdf2-sha256", "iterations": iterations }),
        Kdf::Argon2id {
            iterations,
            memory_kib,
            parallelism,
        } => json!({
            "type": "argon2id",
            "iterations": iterations,
            "memory_kib": memory_kib,
            "parallelism": parallelism,
        }),
    }
}

/// Recompute everything a vector claims, from the inputs alone.
fn compute(case: &Case) -> Value {
    let master = MasterKey::derive(
        case.master_password.as_bytes(),
        &case.email,
        &case.kdf,
    )
    .expect("derive");
    let stretched = master.stretch();
    let user_key = SymmetricKey::from_bytes(&case.user_key_bytes).expect("user key");
    let wrapped = stretched
        .encrypt_with_iv(&case.user_key_bytes, [0x5a; 16])
        .expect("wrap");
    let enc = user_key
        .encrypt_with_iv(case.plaintext.as_bytes(), [0xa5; 16])
        .expect("encrypt");
    json!({
        "name": case.name,
        "slow": case.slow,
        "email": case.email,
        "master_password": case.master_password,
        "kdf": kdf_json(&case.kdf),
        "master_password_hash_b64": master.password_hash_b64(case.master_password.as_bytes()),
        "stretched_key_hex": to_hex(&stretched.to_bytes()),
        "user_key_hex": to_hex(&case.user_key_bytes),
        "wrapped_user_key": wrapped.to_string(),
        "plaintext": case.plaintext,
        "enc_string": enc.to_string(),
    })
}

fn check(case: &Case, expected: &Value) {
    let actual = compute(case);
    for field in [
        "email",
        "master_password",
        "kdf",
        "master_password_hash_b64",
        "stretched_key_hex",
        "user_key_hex",
        "wrapped_user_key",
        "plaintext",
        "enc_string",
    ] {
        assert_eq!(
            actual.get(field),
            expected.get(field),
            "vector `{}` field `{field}` drifted — the vault format changed",
            case.name
        );
    }

    // And the committed ciphertexts must still *open*, not merely match.
    let master = MasterKey::derive(
        case.master_password.as_bytes(),
        &case.email,
        &case.kdf,
    )
    .expect("derive");
    let wrapped: EncString = expected["wrapped_user_key"]
        .as_str()
        .expect("wrapped_user_key")
        .parse()
        .expect("parse wrapped user key");
    let user_key = master.decrypt_user_key(&wrapped).expect("unwrap user key");
    assert_eq!(
        to_hex(&user_key.to_bytes()),
        expected["user_key_hex"].as_str().unwrap(),
        "vector `{}` user key did not unwrap to the committed bytes",
        case.name
    );
    let enc: EncString = expected["enc_string"]
        .as_str()
        .expect("enc_string")
        .parse()
        .expect("parse enc_string");
    assert_eq!(
        &*user_key.decrypt_string(&enc).expect("decrypt"),
        expected["plaintext"].as_str().unwrap(),
        "vector `{}` payload did not decrypt to the committed plaintext",
        case.name
    );
    assert_eq!(
        to_hex(&from_hex(expected["user_key_hex"].as_str().unwrap())),
        expected["user_key_hex"].as_str().unwrap()
    );
}

fn expected_for(vectors: &Value, name: &str) -> Value {
    vectors["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("no committed vector named `{name}` — regenerate"))
        .clone()
}

#[test]
fn fast_vectors_match_the_committed_goldens() {
    let vectors = load();
    for case in cases().iter().filter(|case| !case.slow) {
        check(case, &expected_for(&vectors, &case.name));
    }
}

#[test]
#[ignore = "production KDF work factors are too slow for the default debug-profile suite"]
fn slow_vectors_match_the_committed_goldens() {
    let vectors = load();
    for case in cases().iter().filter(|case| case.slow) {
        check(case, &expected_for(&vectors, &case.name));
    }
}

#[test]
fn every_committed_vector_is_still_defined() {
    let vectors = load();
    let defined: Vec<String> = cases().into_iter().map(|case| case.name).collect();
    for committed in vectors["cases"].as_array().expect("cases") {
        let name = committed["name"].as_str().expect("name");
        assert!(
            defined.iter().any(|d| d == name),
            "committed vector `{name}` has no definition — delete it deliberately or restore it"
        );
    }
    assert_eq!(
        vectors["cases"].as_array().unwrap().len(),
        defined.len(),
        "every defined vector must be committed"
    );
}

/// RFC 7914 §11 — PBKDF2-HMAC-SHA256 known answers. Independent of this
/// crate: if `pbkdf2`/`sha2` ever regress, this fails before any vault
/// vector does.
#[test]
fn pbkdf2_hmac_sha256_matches_the_published_vectors() {
    use sha2::Sha256;
    for (iterations, expected) in [
        (
            1u32,
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
        ),
        (
            2,
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43",
        ),
        (
            4096,
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a",
        ),
    ] {
        let mut out = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(b"password", b"salt", iterations, &mut out);
        assert_eq!(to_hex(&out), expected, "PBKDF2 c={iterations}");
    }
}

/// RFC 5869 §A.2 — HKDF-SHA256 Expand from a known PRK. Bitwarden's stretch
/// step is Expand-only (the master key is already uniformly random), so this
/// is exactly the primitive under test.
#[test]
fn hkdf_sha256_expand_matches_the_published_vector() {
    let prk = from_hex("06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244");
    let info = from_hex(
        "b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7\
         d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
    );
    let hkdf = hkdf::Hkdf::<sha2::Sha256>::from_prk(&prk).expect("prk");
    let mut okm = [0u8; 82];
    hkdf.expand(&info, &mut okm).expect("expand");
    assert_eq!(
        to_hex(&okm),
        "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271c\
         b41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87"
    );
}

/// Regenerate the committed vectors after an intentional format change.
/// Deliberately `#[ignore]`d: a golden file that regenerates itself on every
/// run is not a golden file.
#[test]
#[ignore = "regenerates tests/vectors/crypto_vectors.json"]
fn regenerate() {
    let cases: Vec<Value> = cases().iter().map(compute).collect();
    let document = json!({
        "note": "Self-generated golden vectors for the Bitwarden key ladder. \
                 Fixture credentials only — no real account. Regenerate with \
                 `cargo test -p opensesame-provider-bitwarden --test crypto_vectors -- --ignored regenerate`.",
        "ladder": "master password + email(salt) -> KDF -> master key -> \
                   {PBKDF2(master key, salt=password, 1) = server hash; \
                    HKDF-Expand(info=enc|mac) = stretched key -> unwraps user key}",
        "cases": cases,
    });
    let path = vectors_path();
    std::fs::create_dir_all(path.parent().unwrap()).expect("create vectors dir");
    std::fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&document).expect("serialize")),
    )
    .expect("write vectors");
    eprintln!("wrote {}", path.display());
}
