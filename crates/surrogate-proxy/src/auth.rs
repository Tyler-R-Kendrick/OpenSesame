//! Caller identity for one run: a random proxy credential the child presents
//! as `Proxy-Authorization: Basic` on every request that opens a tunnel or
//! asks the proxy for a URL.
//!
//! A run has its own listener *and* its own credential, so the identity
//! handed to [`SurrogateLedger::admit`](opensesame_invoke_through::SurrogateLedger::admit)
//! is attested twice over: the socket it arrived on and the secret it
//! carried. The comparison is constant-time over the decoded `user:secret`
//! bytes. The credential lives in the child's `HTTPS_PROXY`, so it is as
//! private as the child's environment and no more; it never appears in a
//! `Debug`, an error or a log line here.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use hyper::header::HeaderValue;
use rand_core::{OsRng, RngCore};
use secrecy::{ExposeSecret, SecretString};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

/// The user half of the proxy credential. The secret is what authenticates;
/// a fixed user keeps the URL free of anything a run id might contain.
const PROXY_USER: &str = "opensesame";

/// Sixteen bytes from the OS, as lowercase hex.
pub(crate) fn random_hex() -> Zeroizing<String> {
    let mut bytes = Zeroizing::new([0_u8; 16]);
    OsRng.fill_bytes(bytes.as_mut());
    let mut out = Zeroizing::new(String::with_capacity(32));
    for byte in bytes.iter() {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

/// Sixteen raw bytes from the OS, for surrogate issue.
pub(crate) fn random_entropy() -> [u8; 16] {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// One run's proxy credential.
pub(crate) struct ProxyCredential {
    /// `user:secret`, exactly as a client's Basic header decodes.
    expected: SecretString,
}

impl std::fmt::Debug for ProxyCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProxyCredential(<redacted>)")
    }
}

impl ProxyCredential {
    pub(crate) fn generate() -> Self {
        let secret = random_hex();
        Self {
            expected: SecretString::from(format!("{PROXY_USER}:{}", secret.as_str())),
        }
    }

    /// The proxy URL a child puts in `HTTPS_PROXY`, credential included.
    pub(crate) fn proxy_url(&self, addr: std::net::SocketAddr) -> SecretString {
        SecretString::from(format!("http://{}@{addr}", self.expected.expose_secret()))
    }

    /// Whether `header` is `Basic base64(user:secret)` for this run.
    pub(crate) fn admits(&self, header: Option<&HeaderValue>) -> bool {
        let Some(value) = header.and_then(|v| v.to_str().ok()) else {
            return false;
        };
        let Some((scheme, encoded)) = value.trim().split_once(' ') else {
            return false;
        };
        if !scheme.eq_ignore_ascii_case("basic") {
            return false;
        }
        let Ok(decoded) = STANDARD.decode(encoded.trim()).map(Zeroizing::new) else {
            return false;
        };
        decoded
            .as_slice()
            .ct_eq(self.expected.expose_secret().as_bytes())
            .into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basic(pair: &str) -> HeaderValue {
        HeaderValue::from_str(&format!("Basic {}", STANDARD.encode(pair))).unwrap()
    }

    #[test]
    fn only_the_runs_own_basic_credential_is_admitted() {
        let credential = ProxyCredential::generate();
        let right = credential.expected.expose_secret().to_owned();
        assert!(credential.admits(Some(&basic(&right))));
        let lower = HeaderValue::from_str(&format!("basic {}", STANDARD.encode(&right))).unwrap();
        assert!(credential.admits(Some(&lower)));
        assert!(!credential.admits(None));
        assert!(!credential.admits(Some(&basic("opensesame:guess"))));
        assert!(!credential.admits(Some(&basic(&format!("{right}x")))));
        let bearer = HeaderValue::from_str(&format!("Bearer {right}")).unwrap();
        assert!(!credential.admits(Some(&bearer)));
        let garbage = HeaderValue::from_static("Basic !!!not-base64");
        assert!(!credential.admits(Some(&garbage)));
    }

    #[test]
    fn two_runs_never_share_a_credential_and_debug_names_neither() {
        let a = ProxyCredential::generate();
        let b = ProxyCredential::generate();
        assert_ne!(a.expected.expose_secret(), b.expected.expose_secret());
        let a_secret = a.expected.expose_secret().to_owned();
        assert!(!b.admits(Some(&basic(&a_secret))));
        let rendered = format!("{a:?}");
        assert!(!rendered.contains(&a_secret[PROXY_USER.len() + 1..]));
    }
}
