//! Validate original Node osr2/osr1 AEAD without exposing a device key or plaintext.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use std::io;
use zeroize::Zeroizing;
const NONCE: usize = 24;
const WRAPPED: usize = 48;
const HEADER: usize = NONCE * 2 + WRAPPED;
const TAG: usize = 16;
const MAX_WIRE: usize = 16 * 1024 * 1024;
/// Fixed codec domain DATA. A caller-selected domain never grants access or ownership.
#[derive(Clone, Copy)]
pub(crate) enum NodeAtRestDomain {
    #[cfg(test)]
    OriginFile,
    DeviceRecord,
    VaultGeneration,
}
impl NodeAtRestDomain {
    fn store(self) -> &'static str {
        match self {
            #[cfg(test)]
            Self::OriginFile => "origin-file",
            Self::DeviceRecord => "node-device-record-v1",
            Self::VaultGeneration => "node-vault-generation-v1",
        }
    }
}
fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "original Node ciphertext unavailable",
    )
}
fn aad(binding: &[u8], purpose: &str) -> io::Result<Vec<u8>> {
    serde_json::to_vec(&["osr2", purpose, &URL_SAFE_NO_PAD.encode(binding)]).map_err(|_| refused())
}
/// Exact Node codec authentication only. The actual retained State must borrow its private key
/// and derive this domain/name from its captured original logical and physical addresses.
/// # Errors
/// Refuses bad roots, malformed/noncanonical encoding, unknown versions, wrong binding and tags.
pub(crate) fn validate_node_at_rest_ciphertext(
    key: &[u8],
    domain: NodeAtRestDomain,
    name: &str,
    wire: &[u8],
) -> io::Result<()> {
    if key.len() != 32 || name.is_empty() || name.len() > 4096 || wire.len() > MAX_WIRE {
        return Err(refused());
    }
    let text = std::str::from_utf8(wire).map_err(|_| refused())?;
    let (prefix, encoded) = text.split_once('.').ok_or_else(refused)?;
    if prefix != "osr2" && prefix != "osr1" {
        return Err(refused());
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| refused())?;
    if URL_SAFE_NO_PAD.encode(&bytes) != encoded {
        return Err(refused());
    }
    let plaintext = if prefix == "osr1" {
        if name.contains('\0') || bytes.len() < NONCE + TAG {
            return Err(refused());
        }
        let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| refused())?;
        let binding = format!("opensesame.at-rest.v1\0{}\0{name}", domain.store());
        Zeroizing::new(
            cipher
                .decrypt(
                    XNonce::from_slice(&bytes[..NONCE]),
                    Payload {
                        msg: &bytes[NONCE..],
                        aad: binding.as_bytes(),
                    },
                )
                .map_err(|_| refused())?,
        )
    } else {
        if bytes.len() < HEADER + TAG {
            return Err(refused());
        }
        let binding = serde_json::to_vec(&["opensesame.at-rest.v2", domain.store(), name])
            .map_err(|_| refused())?;
        let mut wrapping_secret = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(b"opensesame.at-rest.v2.kek"), key)
            .expand(&binding, &mut wrapping_secret[..])
            .map_err(|_| refused())?;
        let wrapper =
            XChaCha20Poly1305::new_from_slice(&wrapping_secret[..]).map_err(|_| refused())?;
        let data_key = Zeroizing::new(
            wrapper
                .decrypt(
                    XNonce::from_slice(&bytes[..NONCE]),
                    Payload {
                        msg: &bytes[NONCE..NONCE + WRAPPED],
                        aad: &aad(&binding, "wrap")?,
                    },
                )
                .map_err(|_| refused())?,
        );
        if data_key.len() != 32 {
            return Err(refused());
        }
        let cipher = XChaCha20Poly1305::new_from_slice(&data_key).map_err(|_| refused())?;
        Zeroizing::new(
            cipher
                .decrypt(
                    XNonce::from_slice(&bytes[NONCE + WRAPPED..HEADER]),
                    Payload {
                        msg: &bytes[HEADER..],
                        aad: &aad(&binding, "data")?,
                    },
                )
                .map_err(|_| refused())?,
        )
    };
    // Node's original TextDecoder is fatal UTF-8. Valid AEAD carrying invalid UTF-8 also refuses.
    std::str::from_utf8(&plaintext).map_err(|_| refused())?;
    Ok(())
}
#[cfg(test)]
#[path = "node_at_rest_ciphertext_tests.rs"]
mod tests;
