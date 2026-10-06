//! Destination-bound private request policy. Network and credential I/O stay in adapters.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub capability: String,
    pub method: String,
    pub reference: String,
    pub destination: String,
    pub destination_fingerprint: String,
    pub header: String,
    pub prefix: String,
    /// Exact normalized URL is private authority state, never a public receipt.
    #[serde(skip)]
    pub full_url: String,
}
/// # Errors
/// Rejects unsupported destinations, references, and header injection.
pub fn describe(
    href: &str,
    reference: &str,
    header: &str,
    prefix: &str,
) -> anyhow::Result<Binding> {
    anyhow::ensure!(
        href.len() <= 2048 && !href.contains('\0'),
        "Request URL is too long"
    );
    let url = url::Url::parse(href).map_err(|_| anyhow::anyhow!("Invalid request URL"))?;
    anyhow::ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
            && url.fragment().is_none(),
        "Request requires HTTPS on port 443 without userinfo or fragment"
    );
    reference_location(reference)?;
    let header = if header.eq_ignore_ascii_case("Authorization") {
        "Authorization"
    } else if header.eq_ignore_ascii_case("X-API-Key") {
        "X-API-Key"
    } else {
        anyhow::bail!("Request header must be Authorization or X-API-Key")
    };
    anyhow::ensure!(
        prefix.len() <= 64 && !prefix.contains(['\r', '\n', '\0']),
        "Invalid credential prefix"
    );
    let full_url = url.to_string();
    let fingerprint = format!("{:x}", Sha256::digest(full_url.as_bytes()));
    Ok(Binding {
        capability: "request".into(),
        method: "GET".into(),
        reference: reference.into(),
        destination: url.origin().ascii_serialization(),
        destination_fingerprint: fingerprint,
        header: header.into(),
        prefix: prefix.into(),
        full_url,
    })
}
impl Binding {
    #[must_use]
    pub fn matches(&self, other: &Self) -> bool {
        self.capability == other.capability
            && self.method == other.method
            && self.reference == other.reference
            && self.destination == other.destination
            && self.destination_fingerprint == other.destination_fingerprint
            && self.header == other.header
            && self.prefix == other.prefix
    }
    /// # Errors
    /// Verify the private URL agrees with all public authority fields.
    pub fn validate_private_url(&self) -> anyhow::Result<()> {
        let prepared = describe(&self.full_url, &self.reference, &self.header, &self.prefix)?;
        anyhow::ensure!(
            self.matches(&prepared),
            "Request authority does not match its private URL"
        );
        Ok(())
    }
}
/// # Errors
/// Rejects malformed references before invoking a provider.
pub fn reference_location(reference: &str) -> anyhow::Result<(String, String)> {
    fn decode(part: &str) -> anyhow::Result<String> {
        let mut bytes = Vec::new();
        let mut i = 0;
        while i < part.len() {
            if part.as_bytes()[i] == b'%' {
                let hex = part
                    .get(i + 1..i + 3)
                    .ok_or_else(|| anyhow::anyhow!("Secret reference is malformed"))?;
                bytes.push(
                    u8::from_str_radix(hex, 16)
                        .map_err(|_| anyhow::anyhow!("Secret reference is malformed"))?,
                );
                i += 3;
            } else {
                bytes.push(part.as_bytes()[i]);
                i += 1;
            }
        }
        let result = String::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!("Secret reference is malformed"))?;
        anyhow::ensure!(
            !result.contains(['\r', '\n', '\0']),
            "Secret reference is malformed"
        );
        Ok(result)
    }
    anyhow::ensure!(
        reference.starts_with("op://") && !reference.contains(['\r', '\n', '\0', '?', '#']),
        "Secret reference is malformed"
    );
    let parts: Vec<_> = reference[5..].split('/').collect();
    anyhow::ensure!(
        parts.len() >= 3 && parts.iter().all(|p| !p.is_empty()),
        "Secret reference is malformed"
    );
    Ok((decode(parts[0])?, decode(parts[1])?))
}
fn subnet4(ip: Ipv4Addr, base: [u8; 4], bits: u32) -> bool {
    let mask = u32::MAX << (32 - bits);
    u32::from(ip) & mask == u32::from(Ipv4Addr::from(base)) & mask
}
fn subnet6(ip: Ipv6Addr, base: &str, bits: u32) -> bool {
    let mask = u128::MAX << (128 - bits);
    base.parse::<Ipv6Addr>()
        .is_ok_and(|base| u128::from(ip) & mask == u128::from(base) & mask)
}
#[must_use]
pub fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ![
            ([0, 0, 0, 0], 8),
            ([10, 0, 0, 0], 8),
            ([100, 64, 0, 0], 10),
            ([127, 0, 0, 0], 8),
            ([169, 254, 0, 0], 16),
            ([172, 16, 0, 0], 12),
            ([192, 0, 0, 0], 24),
            ([192, 0, 2, 0], 24),
            ([192, 88, 99, 0], 24),
            ([192, 168, 0, 0], 16),
            ([198, 18, 0, 0], 15),
            ([198, 51, 100, 0], 24),
            ([203, 0, 113, 0], 24),
            ([224, 0, 0, 0], 4),
            ([240, 0, 0, 0], 4),
        ]
        .iter()
        .any(|(base, bits)| subnet4(ip, *base, *bits)),
        IpAddr::V6(ip) => {
            subnet6(ip, "2000::", 3)
                && ip.to_ipv4_mapped().is_none()
                && ![
                    ("::", 128),
                    ("::1", 128),
                    ("64:ff9b::", 96),
                    ("64:ff9b:1::", 48),
                    ("100::", 64),
                    ("2001::", 23),
                    ("2001:db8::", 32),
                    ("2002::", 16),
                    ("3fff::", 20),
                    ("3ffe::", 16),
                    ("5f00::", 16),
                    ("fc00::", 7),
                    ("fe80::", 10),
                    ("ff00::", 8),
                ]
                .iter()
                .any(|(base, bits)| subnet6(ip, base, *bits))
        }
    }
}
/// # Errors
/// Any unsafe address poisons the whole resolution, before credential access.
pub fn validate_addresses(addresses: &[IpAddr]) -> anyhow::Result<()> {
    anyhow::ensure!(
        !addresses.is_empty() && addresses.iter().all(|ip| public_address(*ip)),
        "Destination must resolve only to public addresses"
    );
    Ok(())
}
/// # Errors
/// Strip one transport newline, reject empty and multiline credentials.
pub fn credential(value: &str) -> anyhow::Result<&str> {
    let value = value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value);
    anyhow::ensure!(
        !value.is_empty() && !value.contains(['\r', '\n', '\0']),
        "Credential cannot be used as an HTTP header"
    );
    Ok(value)
}
#[must_use]
pub fn receipt(binding: &Binding, status: u16, body: &[u8], secret: &str) -> serde_json::Value {
    let bytes = body.len();
    let body = String::from_utf8_lossy(body);
    let escaped = serde_json::to_string(secret).unwrap_or_default();
    let escaped = escaped
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or_default();
    let echoes = body.matches(secret).count()
        + if escaped == secret || escaped.is_empty() {
            0
        } else {
            body.matches(escaped).count()
        };
    serde_json::json!({"ok":(200..300).contains(&status),"status":status,"destination":binding.destination,"destinationFingerprint":binding.destination_fingerprint,"reference":binding.reference,"responseBytes":bytes,"secretEchoes":echoes})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destination_and_public_dns_are_required_before_credential() {
        for url in [
            "http://example.com",
            "https://example.com:8443",
            "https://user:pass@example.com",
            "https://example.com/#fragment",
        ] {
            assert!(describe(url, "op://Vault/Item/token", "Authorization", "Bearer ").is_err());
        }
        assert!(describe("https://example.com", "op://Vault/Item/token", "Cookie", "").is_err());
        assert!(describe(
            "https://example.com",
            "op://Vault/Item/token",
            "Authorization",
            "\r\n"
        )
        .is_err());
        let public = "8.8.8.8".parse().unwrap();
        assert!(validate_addresses(&[public]).is_ok());
        for blocked in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "192.0.2.1",
            "::1",
            "::ffff:8.8.8.8",
            "2001:db8::1",
            "fc00::1",
            "::8.8.8.8",
            "4000::1",
            "3ffe::1",
        ] {
            assert!(validate_addresses(&[public, blocked.parse().unwrap()]).is_err());
        }
        assert!(validate_addresses(&[]).is_err());
    }
    #[test]
    fn private_response_receipt_omits_paths_queries_and_plaintext() {
        let binding = describe(
            "https://example.com/private/token?secret=URLTOKEN",
            "op://Vault/Item/token",
            "X-API-Key",
            "",
        )
        .unwrap();
        let output = receipt(&binding, 200, b"SECRET SECRET", "SECRET");
        assert_eq!(output["secretEchoes"], 2);
        assert_eq!(output["responseBytes"], 13);
        assert_eq!(output["destination"], "https://example.com");
        for value in ["SECRET", "URLTOKEN", "/private/"] {
            assert!(!output.to_string().contains(value));
        }
        assert_eq!(credential("token\r\n").unwrap(), "token");
        for bad in ["", "token\n\n", "token\r\nnext", "token\0next"] {
            assert!(credential(bad).is_err());
        }
        let special = "token\"\\end";
        let encoded = serde_json::to_string(special).unwrap();
        let body = format!("private-person-data {special} {encoded}");
        let receipt = receipt(&binding, 200, body.as_bytes(), special);
        assert_eq!(receipt["secretEchoes"], 2);
        assert!(!receipt.to_string().contains("private-person-data"));
        assert!(describe(
            "https://example.com",
            "op://Vault/Item/token",
            "Authorization",
            "\0"
        )
        .is_err());
    }
}
