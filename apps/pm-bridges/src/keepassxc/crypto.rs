//! NaCl `box` for the keepassxc-protocol: X25519 + XSalsa20-Poly1305.
//!
//! Three keypairs exist in the protocol, and conflating them is the classic
//! way to get this wrong:
//!
//! | keypair | who makes it | lifetime | what it does |
//! |---|---|---|---|
//! | **host key** | this bridge | one process | encrypts the session |
//! | **client key** | the extension | one browser session | encrypts the session |
//! | **identification key** | the extension | forever | proves "I was approved once" |
//!
//! Only the first two ever encrypt anything. The identification key's public
//! half is the sole thing persisted (C5) and is compared, never used to
//! decrypt — a quirk of the protocol, noted in its own spec.
//!
//! No AEAD is hand-rolled here: `crypto_box` (RustCrypto, MIT/Apache-2.0) is
//! the implementation, and it lives only in this crate, never in the daemon's
//! dependency tree (C4).

use crypto_box::aead::{Aead, OsRng};
use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};

use crate::keepassxc::proto::{decode_b64, encode_b64, NONCE_LEN};
use crate::BridgeError;

/// The extension-side secret key type, re-exported so code standing in for a
/// client does not need its own `crypto_box` dependency.
pub type ClientSecretKey = SecretKey;

/// This process's ephemeral session keypair.
pub struct HostKeys {
    secret: SecretKey,
    public: PublicKey,
}

impl HostKeys {
    /// Generate a fresh session keypair from the OS CSPRNG.
    pub fn generate() -> Self {
        let secret = SecretKey::generate(&mut OsRng);
        let public = secret.public_key();
        Self { secret, public }
    }

    /// Deterministic constructor — tests only, so a handshake can be pinned.
    pub fn from_secret_bytes(bytes: [u8; 32]) -> Self {
        let secret = SecretKey::from_bytes(bytes);
        let public = secret.public_key();
        Self { secret, public }
    }

    pub fn public_b64(&self) -> String {
        encode_b64(self.public.as_bytes())
    }

    /// The shared box with a peer's public key.
    pub fn box_with(&self, peer_public_b64: &str) -> Result<SessionBox, BridgeError> {
        let bytes = decode_b64(peer_public_b64, Some(32))?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        Ok(SessionBox {
            inner: SalsaBox::new(&PublicKey::from_bytes(key), &self.secret),
        })
    }
}

/// An established NaCl box between the host key and one client key.
pub struct SessionBox {
    inner: SalsaBox,
}

impl SessionBox {
    /// Open a base64 box under a base64 nonce.
    pub fn open(&self, message_b64: &str, nonce_b64: &str) -> Result<Vec<u8>, BridgeError> {
        let nonce = decode_b64(nonce_b64, Some(NONCE_LEN))?;
        let ciphertext = decode_b64(message_b64, None)?;
        self.inner
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
            .map_err(|_| BridgeError::Protocol("box did not open".into()))
    }

    /// Seal `plaintext` under a base64 nonce, returning base64 ciphertext.
    pub fn seal(&self, plaintext: &[u8], nonce_b64: &str) -> Result<String, BridgeError> {
        let nonce = decode_b64(nonce_b64, Some(NONCE_LEN))?;
        let ciphertext = self
            .inner
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .map_err(|_| BridgeError::Protocol("box could not be sealed".into()))?;
        Ok(encode_b64(&ciphertext))
    }
}

/// A fresh 24-byte nonce, base64 encoded.
pub fn random_nonce_b64() -> String {
    use rand::RngCore;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    encode_b64(&nonce)
}

/// A fresh client-side keypair — used by the test harness and by anything
/// that needs to play the extension's role.
pub fn generate_client_keys() -> (SecretKey, String) {
    let secret = SecretKey::generate(&mut OsRng);
    let public = encode_b64(secret.public_key().as_bytes());
    (secret, public)
}

/// Build the client half of a session box. The mirror of
/// [`HostKeys::box_with`], for code standing in for the extension.
pub fn client_box(secret: &SecretKey, host_public_b64: &str) -> Result<SessionBox, BridgeError> {
    let bytes = decode_b64(host_public_b64, Some(32))?;
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(SessionBox {
        inner: SalsaBox::new(&PublicKey::from_bytes(key), secret),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keepassxc::proto::increment_nonce_b64;

    #[test]
    fn a_box_round_trips_between_two_parties() {
        let host = HostKeys::generate();
        let (client_secret, client_public) = generate_client_keys();

        let host_side = host.box_with(&client_public).unwrap();
        let client_side = client_box(&client_secret, &host.public_b64()).unwrap();

        let nonce = random_nonce_b64();
        let sealed = client_side.seal(br#"{"action":"get-databasehash"}"#, &nonce).unwrap();
        let opened = host_side.open(&sealed, &nonce).unwrap();
        assert_eq!(opened, br#"{"action":"get-databasehash"}"#);

        // The reply travels under the incremented nonce, as the protocol says.
        let reply_nonce = increment_nonce_b64(&nonce).unwrap();
        let sealed_reply = host_side.seal(b"{\"hash\":\"x\"}", &reply_nonce).unwrap();
        assert_eq!(
            client_side.open(&sealed_reply, &reply_nonce).unwrap(),
            b"{\"hash\":\"x\"}"
        );
        // …and only under that nonce.
        assert!(client_side.open(&sealed_reply, &nonce).is_err());
    }

    #[test]
    fn a_third_party_cannot_open_the_box() {
        let host = HostKeys::generate();
        let (_client_secret, client_public) = generate_client_keys();
        let (_other_secret, other_public) = generate_client_keys();

        let good = host.box_with(&client_public).unwrap();
        let wrong = host.box_with(&other_public).unwrap();

        let nonce = random_nonce_b64();
        let sealed = good.seal(b"secret-bearing frame", &nonce).unwrap();
        assert!(wrong.open(&sealed, &nonce).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let host = HostKeys::generate();
        let (_s, client_public) = generate_client_keys();
        let session = host.box_with(&client_public).unwrap();
        let nonce = random_nonce_b64();
        let sealed = session.seal(b"payload", &nonce).unwrap();

        let mut raw = decode_b64(&sealed, None).unwrap();
        raw[0] ^= 0x01;
        assert!(session.open(&encode_b64(&raw), &nonce).is_err());
    }

    #[test]
    fn malformed_inputs_are_errors_not_panics() {
        let host = HostKeys::generate();
        assert!(host.box_with("not base64!!").is_err());
        assert!(host.box_with(&encode_b64(&[0u8; 8])).is_err());

        let (_s, public) = generate_client_keys();
        let session = host.box_with(&public).unwrap();
        assert!(session.open("****", &random_nonce_b64()).is_err());
        assert!(session.open(&encode_b64(b"short"), "bad-nonce").is_err());
        assert!(session.seal(b"x", &encode_b64(&[0u8; 8])).is_err());
    }

    #[test]
    fn deterministic_host_keys_are_stable() {
        let a = HostKeys::from_secret_bytes([7u8; 32]);
        let b = HostKeys::from_secret_bytes([7u8; 32]);
        assert_eq!(a.public_b64(), b.public_b64());
        assert_ne!(a.public_b64(), HostKeys::from_secret_bytes([8u8; 32]).public_b64());
    }

    #[test]
    fn random_nonces_are_the_right_width_and_differ() {
        let a = random_nonce_b64();
        let b = random_nonce_b64();
        assert_eq!(decode_b64(&a, Some(NONCE_LEN)).unwrap().len(), NONCE_LEN);
        assert_ne!(a, b);
    }
}
