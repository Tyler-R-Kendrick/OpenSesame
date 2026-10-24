//! The key the helper-mint grant file is authenticated under (ADR 0138 §2).
//!
//! The file carries an HMAC-SHA256 over a canonical encoding of its grants,
//! keyed by HKDF-SHA256 of the operator token. A process that can write the
//! file but does not hold the token cannot make it admit anything, and a new
//! operator token invalidates every grant written under the old one.

use std::collections::BTreeMap;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

/// The HKDF info label. A new file shape gets a new label.
const INFO: &[u8] = b"opensesame/daemon/helper-mints/v3";

type HmacSha256 = Hmac<Sha256>;

/// Derived from the operator token. Deliberately without `Debug`: it is never
/// printed or logged.
pub(super) struct GrantKey(Zeroizing<[u8; 32]>);

impl GrantKey {
    /// `None` with no operator token: such a daemon can hold no grants.
    pub(super) fn derive(operator_token: &str) -> Option<Self> {
        if operator_token.is_empty() {
            return None;
        }
        let mut key = Zeroizing::new([0u8; 32]);
        hkdf::Hkdf::<Sha256>::new(None, operator_token.as_bytes())
            .expand(INFO, key.as_mut_slice())
            .ok()?;
        Some(Self(key))
    }

    /// The tag for `grants` under `version`, as hex.
    pub(super) fn sign(
        &self,
        version: u32,
        grants: &BTreeMap<String, Option<String>>,
    ) -> Option<String> {
        let mac = self.mac(version, grants)?;
        Some(hex::encode(mac.finalize().into_bytes()))
    }

    /// Whether `tag` is this key's tag for `grants`, compared in constant time.
    pub(super) fn verifies(
        &self,
        version: u32,
        grants: &BTreeMap<String, Option<String>>,
        tag: &str,
    ) -> bool {
        let Ok(tag) = hex::decode(tag) else {
            return false;
        };
        self.mac(version, grants)
            .is_some_and(|mac| mac.verify_slice(&tag).is_ok())
    }

    fn mac(&self, version: u32, grants: &BTreeMap<String, Option<String>>) -> Option<HmacSha256> {
        let mut mac = HmacSha256::new_from_slice(self.0.as_slice()).ok()?;
        mac.update(&canonical(version, grants));
        Some(mac)
    }
}

/// The bytes the tag covers: the version, the number of grants, then each
/// grant in connection order. Every string is length-prefixed and an absent
/// installation is its own marker, so no two grant sets encode alike.
fn canonical(version: u32, grants: &BTreeMap<String, Option<String>>) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&version.to_be_bytes());
    put_len(&mut out, grants.len());
    for (connection_id, installation_id) in grants {
        put_str(&mut out, connection_id);
        if let Some(id) = installation_id {
            out.push(1);
            put_str(&mut out, id);
        } else {
            out.push(0);
        }
    }
    out
}

fn put_len(out: &mut Vec<u8>, len: usize) {
    out.extend_from_slice(&(len as u64).to_be_bytes());
}

fn put_str(out: &mut Vec<u8>, value: &str) {
    put_len(out, value.len());
    out.extend_from_slice(value.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(entries: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
        entries
            .iter()
            .map(|(c, i)| ((*c).to_string(), i.map(String::from)))
            .collect()
    }

    #[test]
    fn a_tag_verifies_only_for_its_own_grants_version_and_token() {
        let key = GrantKey::derive("operator-token-0123456789abcdefghijklmn").unwrap();
        let grants = set(&[("conn_a", Some("1")), ("conn_b", None)]);
        let tag = key.sign(3, &grants).unwrap();
        assert!(key.verifies(3, &grants, &tag));
        assert!(!key.verifies(2, &grants, &tag));
        // Boundaries move: the same characters, split differently.
        assert!(!key.verifies(3, &set(&[("conn_a1", None), ("conn_b", None)]), &tag));
        assert!(!key.verifies(3, &grants, "not hex"));
        let other = GrantKey::derive("another-token-0123456789abcdefghijklmnop").unwrap();
        assert!(!other.verifies(3, &grants, &tag));
        assert!(GrantKey::derive("").is_none());
    }
}
