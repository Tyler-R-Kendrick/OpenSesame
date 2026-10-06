use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;

fn legacy(root: &[u8; 32], plain: &str) -> String {
    let nonce = [4u8; 24];
    let ciphertext = XChaCha20Poly1305::new(root.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plain.as_bytes(),
                aad: b"opensesame.log.v1",
            },
        )
        .unwrap();
    format!(
        "osl1.{}",
        URL_SAFE_NO_PAD.encode([nonce.as_slice(), &ciphertext].concat())
    )
}

fn unwrap(value: &str) -> Vec<u8> {
    let info = b"opensesame:event-seal:kek:v2";
    let context = b"customer:";
    let mut customer_info = info.to_vec();
    customer_info.extend_from_slice(context);
    let mut wrapping = [0; 32];
    Hkdf::<Sha256>::new(None, &[7; 32])
        .expand(&customer_info, &mut wrapping)
        .unwrap();
    let mut kek = [0; 32];
    Hkdf::<Sha256>::new(Some(info), &wrapping)
        .expand(b"sealed-log.line", &mut kek)
        .unwrap();
    let mut aad = info.to_vec();
    aad.extend_from_slice(&(context.len() as u64).to_be_bytes());
    aad.extend_from_slice(context);
    aad.extend_from_slice(b"sealed-log.line");
    let packed = URL_SAFE_NO_PAD.decode(&value[5..]).unwrap();
    let dek = XChaCha20Poly1305::new((&kek).into())
        .decrypt(
            XNonce::from_slice(&packed[..24]),
            Payload {
                msg: &packed[24..72],
                aad: &aad,
            },
        )
        .unwrap();
    let plaintext = XChaCha20Poly1305::new(dek.as_slice().into())
        .decrypt(
            XNonce::from_slice(&packed[72..96]),
            Payload {
                msg: &packed[96..],
                aad: &aad,
            },
        )
        .unwrap();
    assert_eq!(plaintext, b"canary customer event");
    dek
}

#[test]
fn an_independent_oracle_unwraps_distinct_data_keys() {
    let key = LogKey::from_bytes([7; 32]);
    let one = seal_line(&key, "canary customer event");
    let two = seal_line(&key, "canary customer event");
    assert_ne!(unwrap(&one), unwrap(&two));
    assert!(!one.contains("canary") && !two.contains("customer"));
}

#[test]
fn copied_root_cannot_open_lines_under_a_different_trusted_key_path() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.key");
    let b = dir.path().join("b.key");
    let first = LogKey::load_or_create(&a).unwrap();
    std::fs::copy(&a, &b).unwrap();
    let second = LogKey::load(&b).unwrap();
    let line = seal_line(&first, "customer a event");
    assert!(open_line(&second, &line).is_none());
    assert_eq!(
        open_line(&LogKey::load(&a).unwrap(), &line).as_deref(),
        Some("customer a event")
    );
}

#[test]
fn legacy_ciphertext_migrates_to_envelopes_without_changing_its_plaintext() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("log");
    let key = LogKey::from_bytes([7; 32]);
    let old = legacy(&[7; 32], "legacy line");
    assert_eq!(open_line(&key, &old).as_deref(), Some("legacy line"));
    std::fs::write(&path, format!("{old}\n")).unwrap();
    assert_eq!(seal_existing(&path, &key).unwrap(), 1);
    assert!(std::fs::read_to_string(&path).unwrap().starts_with("osl2."));
    assert_eq!(read_tail(&path, &key, 1).unwrap(), ["legacy line"]);
    assert_eq!(seal_existing(&path, &key).unwrap(), 0);
}

#[test]
fn reserved_unknown_or_tampered_lines_never_become_plaintext_or_new_envelopes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("log");
    let key = LogKey::from_bytes([7; 32]);
    let good = seal_line(&key, "canary customer event");
    let mut packed = URL_SAFE_NO_PAD.decode(&good[5..]).unwrap();
    for position in [0, 24, 72, packed.len() - 1] {
        packed[position] ^= 1;
        let corrupt = format!("osl2.{}", URL_SAFE_NO_PAD.encode(&packed));
        assert!(open_line(&key, &corrupt).is_none());
        packed[position] ^= 1;
    }
    for value in [
        "osl1.invalid",
        "osl2.",
        "osl3.invalid",
        &good[..good.len() - 3],
    ] {
        std::fs::write(&path, format!("{value}\n")).unwrap();
        assert!(seal_existing(&path, &key).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{value}\n")
        );
        assert_eq!(read_tail(&path, &key, 1).unwrap(), [UNREADABLE]);
    }
}

#[test]
fn missing_root_does_not_mint_for_live_or_rotated_ciphertext() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("log");
    std::fs::write(rotated_path(&path, 1), legacy(&[7; 32], "old")).unwrap();
    assert!(open_sink(&path, None).is_err());
    assert!(!key_path_for(&path, None).exists());
    assert!(!path.exists());
}

#[test]
fn shared_typescript_envelope_vectors_open_in_rust() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../spec/conformance/sealed-log-envelope-vectors.json"
    ))
    .unwrap();
    let key = LogKey::from_bytes([7; 32]);
    for vector in vectors["lines"].as_array().unwrap() {
        assert_eq!(
            open_line(&key, vector["sealed"].as_str().unwrap()).as_deref(),
            vector["plain"].as_str()
        );
    }
}

#[test]
fn export_rust_envelope_for_typescript_oracle() {
    if let Some(path) = std::env::var_os("SEALED_LOG_ORACLE_PATH") {
        let value = serde_json::json!({"key": hex::encode([7; 32]), "lines": [
            {"plain": "Rust customer event ✓", "sealed": seal_line(&LogKey::from_bytes([7; 32]), "Rust customer event ✓")}
        ]});
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
}

#[test]
fn direct_file_construction_refuses_unknown_wrong_key_or_rotated_ciphertext() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("log");
    let original = format!(
        "{}\n",
        seal_line(&LogKey::from_bytes([7; 32]), "customer event")
    );
    std::fs::write(&path, &original).unwrap();
    assert!(SealedLogFile::open(&path, LogKey::from_bytes([8; 32])).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    std::fs::write(&path, "osl3.invalid\n").unwrap();
    assert!(SealedLogFile::open(&path, LogKey::from_bytes([7; 32])).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "osl3.invalid\n");
    std::fs::write(&path, "").unwrap();
    std::fs::write(rotated_path(&path, 2), "osl2.invalid\n").unwrap();
    assert!(SealedLogFile::open(&path, LogKey::from_bytes([7; 32])).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
}
