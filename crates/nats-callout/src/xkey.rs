//! The `xkv1` envelope nats-server uses when `auth_callout.xkey` is set: the
//! request payload is a NaCl box from the server's curve key to the callout
//! service's curve key, and the response must be a box back to the server's
//! key. Both ends are `nkeys::XKey`, the reference implementation.
//!
//! The server's public curve key travels in the `Nats-Server-Xkey` message
//! header (and again inside the sealed claims as `server_id.xkey`); the two
//! must agree.

use crate::error::{misconfigured, CalloutError};

const ENVELOPE_PREFIX: &[u8] = b"xkv1";

/// The callout service's curve key pair.
pub struct CalloutXKey {
    key: nkeys::XKey,
}

impl std::fmt::Debug for CalloutXKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CalloutXKey")
            .field("public_key", &self.key.public_key())
            .finish()
    }
}

impl CalloutXKey {
    /// From a curve seed (`SX…`).
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when the seed is not a curve seed.
    pub fn from_seed(seed: &str) -> Result<Self, CalloutError> {
        let key = nkeys::XKey::from_seed(seed.trim())
            .map_err(|_| misconfigured("callout xkey seed is not a curve seed"))?;
        Ok(Self { key })
    }

    /// A fresh key for tests and one-off tooling.
    #[must_use]
    pub fn generate() -> Self {
        Self {
            key: nkeys::XKey::new(),
        }
    }

    /// The public curve key (`X…`) to put in `auth_callout.xkey`.
    #[must_use]
    pub fn public_key(&self) -> String {
        self.key.public_key()
    }

    /// The seed, for writing a test server's configuration only.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when the key has no seed.
    pub fn seed(&self) -> Result<String, CalloutError> {
        self.key
            .seed()
            .map_err(|_| misconfigured("xkey has no seed"))
    }

    /// Open a sealed request from `server_xkey`.
    ///
    /// # Errors
    ///
    /// `XkeyOpenFailed` for a bad sender key or a box that does not open.
    pub fn open(&self, sealed: &[u8], server_xkey: &str) -> Result<Vec<u8>, CalloutError> {
        let sender = nkeys::XKey::from_public_key(server_xkey.trim())
            .map_err(|_| CalloutError::XkeyOpenFailed)?;
        self.key
            .open(sealed, &sender)
            .map_err(|_| CalloutError::XkeyOpenFailed)
    }

    /// Seal a response to `server_xkey`.
    ///
    /// # Errors
    ///
    /// `SigningFailed` for a bad recipient key or a sealing failure.
    pub fn seal(&self, plaintext: &[u8], server_xkey: &str) -> Result<Vec<u8>, CalloutError> {
        let recipient = nkeys::XKey::from_public_key(server_xkey.trim())
            .map_err(|_| CalloutError::SigningFailed)?;
        self.key
            .seal(plaintext, &recipient)
            .map_err(|_| CalloutError::SigningFailed)
    }
}

/// Is this payload an `xkv1` envelope rather than a bare JWT?
#[must_use]
pub fn is_sealed(payload: &[u8]) -> bool {
    payload.starts_with(ENVELOPE_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_to_service_round_trip() {
        let server = CalloutXKey::generate();
        let service = CalloutXKey::generate();
        let sealed = server.seal(b"eyJ.request.sig", &service.public_key()).unwrap();
        assert!(is_sealed(&sealed));
        assert!(!is_sealed(b"eyJ.request.sig"));
        let opened = service.open(&sealed, &server.public_key()).unwrap();
        assert_eq!(opened, b"eyJ.request.sig");
        // Wrong sender key: the box does not open.
        let other = CalloutXKey::generate();
        assert_eq!(
            service.open(&sealed, &other.public_key()).unwrap_err(),
            CalloutError::XkeyOpenFailed
        );
        // Wrong recipient: the box does not open.
        assert_eq!(
            other.open(&sealed, &server.public_key()).unwrap_err(),
            CalloutError::XkeyOpenFailed
        );
        assert!(service.open(b"xkv1garbage", &server.public_key()).is_err());
        assert!(service.open(&sealed, "not a key").is_err());
    }

    #[test]
    fn seed_round_trip_and_kind() {
        let k = CalloutXKey::generate();
        let seed = k.seed().unwrap();
        let again = CalloutXKey::from_seed(&seed).unwrap();
        assert_eq!(again.public_key(), k.public_key());
        assert!(!format!("{k:?}").contains(&seed));
        let account_seed = nkeys::KeyPair::new_account().seed().unwrap();
        assert!(CalloutXKey::from_seed(&account_seed).is_err());
    }
}
