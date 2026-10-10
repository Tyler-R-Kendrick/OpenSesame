//! Actual controlled XChaCha/HKDF ciphertext; inner payload is synthetic DATA, not owner proof.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;
pub(super) fn sealed_generation(name: &str, plaintext: &[u8]) -> Vec<u8> {
    let binding =
        serde_json::to_vec(&["opensesame.at-rest.v2", "node-vault-generation-v1", name]).unwrap();
    let mut kek = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(b"opensesame.at-rest.v2.kek"), &[31; 32])
        .expand(&binding, &mut *kek)
        .unwrap();
    let dek = Zeroizing::new([71; 32]);
    let wrap_nonce = [51; 24];
    let nonce = [61; 24];
    let aad = |purpose| {
        serde_json::to_vec(&["osr2", purpose, &URL_SAFE_NO_PAD.encode(&binding)]).unwrap()
    };
    let wrapper = XChaCha20Poly1305::new_from_slice(&*kek).unwrap();
    let cipher = XChaCha20Poly1305::new_from_slice(&*dek).unwrap();
    let mut bytes = wrap_nonce.to_vec();
    bytes.extend(
        wrapper
            .encrypt(
                XNonce::from_slice(&wrap_nonce),
                Payload {
                    msg: &*dek,
                    aad: &aad("wrap"),
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
                    msg: plaintext,
                    aad: &aad("data"),
                },
            )
            .unwrap(),
    );
    format!("osr2.{}", URL_SAFE_NO_PAD.encode(bytes)).into_bytes()
}
