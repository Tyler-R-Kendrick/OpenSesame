//! DER → PEM for handing material to `opensesame_transport_security`, whose
//! constructors take PEM. Pure; the key path returns a zeroizing box.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use secrecy::SecretBox;

/// Wrap one DER object in a PEM block with the given label.
#[must_use]
pub fn der_to_pem(label: &str, der: &[u8]) -> String {
    let body = STANDARD.encode(der);
    let mut out = String::with_capacity(body.len() + body.len() / 64 + label.len() * 2 + 40);
    out.push_str("-----BEGIN ");
    out.push_str(label);
    out.push_str("-----\n");
    for chunk in body.as_bytes().chunks(64) {
        // base64 output is ASCII, so the chunk is valid UTF-8.
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str("-----END ");
    out.push_str(label);
    out.push_str("-----\n");
    out
}

/// Concatenate a DER certificate chain (leaf first) into PEM.
#[must_use]
pub fn chain_to_pem<D: AsRef<[u8]>>(chain: &[D]) -> Vec<u8> {
    let mut out = Vec::new();
    for der in chain {
        out.extend_from_slice(der_to_pem("CERTIFICATE", der.as_ref()).as_bytes());
    }
    out
}

/// Wrap a PKCS#8 DER private key in PEM inside a zeroizing box.
#[must_use]
pub fn key_to_pem(pkcs8_der: &[u8]) -> SecretBox<Vec<u8>> {
    SecretBox::new(Box::new(der_to_pem("PRIVATE KEY", pkcs8_der).into_bytes()))
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret as _;

    use super::*;

    #[test]
    fn wraps_with_labels_and_64_column_lines() {
        let pem = der_to_pem("CERTIFICATE", &[0u8; 100]);
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----\n"));
        assert!(pem.ends_with("-----END CERTIFICATE-----\n"));
        let lines: Vec<&str> = pem.lines().collect();
        assert_eq!(lines[1].len(), 64);
        assert_eq!(lines.len(), 5);
    }

    #[test]
    fn chain_keeps_order_and_key_uses_pkcs8_label() {
        let pem = chain_to_pem(&[vec![1u8], vec![2u8]]);
        let text = String::from_utf8(pem).unwrap();
        assert_eq!(text.matches("BEGIN CERTIFICATE").count(), 2);
        assert!(text.find("AQ==").unwrap() < text.find("Ag==").unwrap());
        let key = key_to_pem(&[3u8; 10]);
        assert!(String::from_utf8_lossy(key.expose_secret()).contains("BEGIN PRIVATE KEY"));
    }
}
