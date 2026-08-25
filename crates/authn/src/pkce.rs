use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub method: &'static str,
}

impl Pkce {
    #[must_use]
    pub fn s256() -> Self {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let mut h = Sha256::new();
        h.update(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(h.finalize());
        Self {
            verifier,
            challenge,
            method: "S256",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn challenge_is_s256() {
        let p = Pkce::s256();
        assert_eq!(p.method, "S256");
        assert!(!p.verifier.is_empty());
        assert_ne!(p.verifier, p.challenge);
    }
}
